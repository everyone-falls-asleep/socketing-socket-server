import Fastify from "fastify";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { instrument } from "@socket.io/admin-ui";
import jwt from "jsonwebtoken";
import fastifyEnv from "@fastify/env";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyRedis from "@fastify/redis";
import fastifyPostgres from "@fastify/postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SELECTION_TIMEOUT = 10 * 1000; // 선택 만료 시간: 10초

const schema = {
  type: "object",
  required: ["PORT", "JWT_SECRET", "CACHE_HOST", "CACHE_PORT", "DB_URL"],
  properties: {
    PORT: {
      type: "string",
    },
    JWT_SECRET: {
      type: "string",
    },
    CACHE_HOST: {
      type: "string",
    },
    CACHE_PORT: {
      type: "integer",
    },
    DB_URL: {
      type: "string",
    },
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({
  logger: true,
});

await fastify.register(fastifyEnv, {
  schema,
  dotenv: true,
});

await fastify.register(cors, {
  origin: "*",
});

await fastify.register(fastifyRedis, {
  host: fastify.config.CACHE_HOST,
  port: fastify.config.CACHE_PORT,
  family: 4,
});

await fastify.register(fastifyPostgres, {
  connectionString: fastify.config.DB_URL,
});

await fastify.register(fastifyStatic, {
  root: join(__dirname, "dist"),
  prefix: "/admin",
  redirect: true,
});

fastify.get("/reservation", async (request, reply) => {
  return reply.sendFile("reservation.html");
});

fastify.get("/liveness", (request, reply) => {
  reply.send({ status: "ok", message: "The server is alive." });
});

fastify.get("/readiness", async (request, reply) => {
  try {
    let redisStatus = { status: "disconnected", message: "" };
    let dbStatus = { status: "disconnected", message: "" };

    // Redis 상태 확인
    try {
      const pingResult = await fastify.redis.ping();
      if (pingResult === "PONG") {
        redisStatus = { status: "connected", message: "Redis is available." };
      } else {
        redisStatus.message = "Redis responded, but not with 'PONG'.";
      }
    } catch (error) {
      redisStatus.message = `Redis connection failed: ${error.message}`;
    }

    // PostgreSQL 상태 확인
    try {
      const client = await fastify.pg.connect();
      if (client) {
        dbStatus = {
          status: "connected",
          message: "PostgreSQL is connected and responsive.",
        };
        client.release(); // 연결 반환
      }
    } catch (error) {
      dbStatus.message = `PostgreSQL connection failed: ${error.message}`;
    }

    // 모든 상태가 정상일 때
    if (redisStatus.status === "connected" && dbStatus.status === "connected") {
      reply.send({
        status: "ok",
        message: "The server is ready.",
        redis: redisStatus,
        database: dbStatus,
      });
    } else {
      // 하나라도 비정상일 때
      reply.status(500).send({
        status: "error",
        message: "The server is not fully ready. See details below.",
        redis: redisStatus,
        database: dbStatus,
      });
    }
  } catch (unexpectedError) {
    // 예기치 못한 오류 처리
    fastify.log.error(
      "Readiness check encountered an unexpected error:",
      unexpectedError
    );
    reply.status(500).send({
      status: "error",
      message: "Unexpected error occurred during readiness check.",
      error: unexpectedError.message,
    });
  }
});

async function getSeatReservationStatus(eventId, eventDateId, seatId) {
  const query = `
  SELECT
    seat.id AS seat_id,
    seat.cx,
    seat.cy,
    seat.area,
    seat.row,
    seat.number,
    reservation.id AS reservation_id,
    eventDate.id AS event_date_id,
    eventDate.date
  FROM seat
  LEFT JOIN reservation ON reservation."seatId" = seat.id AND reservation."deletedAt" IS NULL
  LEFT JOIN event_date AS eventDate ON reservation."eventDateId" = eventDate.id
  WHERE seat."eventId" = $1
  AND (eventDate.id = $2 OR eventDate.id IS NULL)
  AND seat."id" = $3
  LIMIT 1;
`;
  const params = [eventId, eventDateId, seatId];

  const { rows } = await fastify.pg.query(query, params);

  let result = null;

  if (rows[0]) {
    result = {
      id: rows[0].seat_id,
      cx: rows[0].cx,
      cy: rows[0].cy,
      area: rows[0].area,
      row: rows[0].row,
      number: rows[0].number,
      reservations: [],
    };
    if (rows[0].reservation_id) {
      result.reservations.push({ id: rows[0].reservation_id });
      if (rows[0].event_date_id) {
        result.reservations[0].eventDate = {
          id: rows[0].event_date_id,
          date: rows[0].date,
        };
      }
    }
  }

  return result;
}

// 좌석 정보를 가져오는 함수 (DB에서 조회)
async function getSeatsForRoom(eventId, eventDateId) {
  // PostgreSQL 쿼리 실행
  const query = `
      SELECT
        seat.id AS seat_id,
        seat.cx,
        seat.cy,
        seat.area,
        seat.row,
        seat.number,
        reservation.id AS reservation_id,
        eventDate.id AS event_date_id,
        eventDate.date
      FROM seat
      LEFT JOIN reservation ON reservation."seatId" = seat.id AND reservation."deletedAt" IS NULL
      LEFT JOIN event_date AS eventDate ON reservation."eventDateId" = eventDate.id
      WHERE seat."eventId" = $1
      AND (eventDate.id = $2 OR eventDate.id IS NULL);
    `;
  const params = [eventId, eventDateId];

  const { rows } = await fastify.pg.query(query, params);

  // 데이터 가공
  const seatMap = new Map();

  rows.forEach((row) => {
    if (!seatMap.has(row.seat_id)) {
      seatMap.set(row.seat_id, {
        id: row.seat_id,
        cx: row.cx,
        cy: row.cy,
        area: row.area,
        row: row.row,
        number: row.number,
        reservations: [],
        selectedBy: null, // 초기 상태
        updatedAt: null, // 초기 상태
        expirationTime: null, // 초기 상태
      });
    }

    if (row.reservation_id) {
      seatMap.get(row.seat_id).reservations.push({
        id: row.reservation_id,
        eventDate: row.event_date_id
          ? {
              id: row.event_date_id,
              date: row.date,
            }
          : null,
      });
    }
  });

  return Array.from(seatMap.values());
}

// Redis에서 좌석 정보를 저장
async function setSeatDataInRedis(roomName, seatData) {
  await fastify.redis.set(`seatData:${roomName}`, JSON.stringify(seatData));
}

// 좌석 선택 상태를 Redis에 저장
async function updateSeatInRedis(roomName, seatId, seat) {
  await fastify.redis.hset(`seats:${roomName}`, seatId, JSON.stringify(seat));
}

// Redis에서 좌석 선택 상태 가져오기
async function getSeatFromRedis(roomName, seatId) {
  const seatData = await fastify.redis.hget(`seats:${roomName}`, seatId);
  return seatData ? JSON.parse(seatData) : null;
}

// Redis에서 모든 좌석 가져오기
async function getAllSeatsFromRedis(roomName) {
  const seatsData = await fastify.redis.hgetall(`seats:${roomName}`);
  const seats = [];
  for (const seatId in seatsData) {
    seats.push(JSON.parse(seatsData[seatId]));
  }
  return seats;
}

// 좌석 선택 만료를 Redis에서 설정
async function setSeatExpirationInRedis(roomName, seatId) {
  // 만료 시간을 설정하여 키를 설정
  await fastify.redis.set(
    `timer:${roomName}:${seatId}`,
    "active",
    "PX",
    SELECTION_TIMEOUT
  );
}

// Redis에서 좌석 선택 만료 확인
async function isSeatExpired(roomName, seatId) {
  const status = await fastify.redis.exists(`timer:${roomName}:${seatId}`);
  return !status; // 존재하지 않으면 만료됨
}

// Redis Keyspace Notifications를 위한 Subscriber 설정
const redisSubscriber = fastify.redis.duplicate();
// await redisSubscriber.connect();

// Redis Keyspace Notifications 설정
await redisSubscriber.config("SET", "notify-keyspace-events", "Ex");

// 만료 이벤트 패턴 구독
const pattern = `__keyevent@${fastify.redis.options.db || 0}__:expired`;

redisSubscriber.psubscribe(pattern, (err, count) => {
  if (err) {
    fastify.log.error("Failed to subscribe to pattern:", err);
  } else {
    fastify.log.info(
      `Successfully subscribed to pattern: ${pattern}, subscription count: ${count}`
    );
  }
});

// 패턴 메시지 이벤트 리스너 설정
redisSubscriber.on("pmessage", async (pattern, channel, message) => {
  const keyParts = message.split(":");
  if (keyParts[0] === "timer") {
    const roomName = keyParts[1];
    const seatId = keyParts[2];

    await handleExpirationEvent(roomName, seatId);
  }
});

// Redis 잠금을 사용하여 이벤트 중복 방지
const handleExpirationEvent = async (roomName, seatId) => {
  const lockKey = `lock:seat:${roomName}:${seatId}`;

  // 잠금을 설정하고 기존에 잠금이 없었을 경우에만 처리
  const lockAcquired = await fastify.redis.set(
    lockKey,
    "locked",
    "NX",
    "EX",
    10
  );
  if (!lockAcquired) {
    fastify.log.info(`Another process is already handling this: ${lockKey}`);
    return; // 다른 프로세스가 이미 처리 중
  }

  try {
    // 좌석 정보 처리 로직
    const seat = await getSeatFromRedis(roomName, seatId);
    if (seat) {
      seat.selectedBy = null;
      seat.updatedAt = new Date().toISOString();
      seat.expirationTime = null;

      await updateSeatInRedis(roomName, seatId, seat);

      io.to(roomName).emit("seatSelected", {
        seatId: seat.id,
        selectedBy: null,
        updatedAt: seat.updatedAt,
        expirationTime: null,
      });

      fastify.log.info(
        `Selection for seat ${seatId} has expired (room: ${roomName}).`
      );
    }
  } finally {
    // 잠금 해제
    await fastify.redis.del(lockKey);
  }
};

const pubClient = fastify.redis.duplicate();
const subClient = fastify.redis.duplicate();

const io = new Server(fastify.server, {
  cors: {
    origin: "*",
    methods: "*",
    credentials: true,
  },
  transports: ["websocket"],
});

io.adapter(createAdapter(pubClient, subClient));

instrument(io, {
  auth: {
    type: "basic",
    username: "admin",
    password: "$2a$10$QWUn5UhhE3eSAu2a95fVn.PRVaamlJlJBMeT7viIrvgvfCOeUIV2W",
  },
  mode: "development",
});

// 실시간 서버 시간 브로드캐스트
setInterval(() => {
  const serverTime = new Date().toISOString();
  io.emit("serverTime", serverTime);
}, 1000); // 1초마다 서버 시간 전송

const seatData = {}; // Room별 좌석 정보를 저장하는 객체

io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Authentication error"));
  }

  try {
    const decoded = jwt.verify(token, fastify.config.JWT_SECRET);
    socket.data.user = decoded;
    next();
  } catch (err) {
    return next(new Error("Authentication error"));
  }
});

io.on("connection", (socket) => {
  fastify.log.info(`New client connected: ${socket.id}`);

  // 클라이언트가 room 정보를 전달
  socket.on("joinRoom", async ({ eventId, eventDateId }) => {
    if (!eventId || !eventDateId) {
      socket.emit("error", { message: "Invalid room parameters." });
      return;
    }

    // room 이름 생성 (eventId와 eventDateId 조합)
    const roomName = `${eventId}_${eventDateId}`;

    // 클라이언트를 해당 room에 추가
    socket.join(roomName);

    fastify.log.info(`Client ${socket.id} joined room: ${roomName}`);

    try {
      // 좌석 정보 생성 또는 가져오기
      let seats = await getAllSeatsFromRedis(roomName);
      if (seats.length === 0) {
        seats = await getSeatsForRoom(eventId, eventDateId); // DB에서 가져오기

        // Redis에 저장
        for (const seat of seats) {
          await updateSeatInRedis(roomName, seat.id, seat);
        }
        await setSeatDataInRedis(roomName, seats);
      }

      // 클라이언트에게 데이터 전송
      socket.emit("roomJoined", {
        message: `You have joined the room: ${roomName}`,
        seats,
      });
    } catch (error) {
      fastify.log.error(`Error fetching data for room ${roomName}:`, error);
      socket.emit("error", {
        message: "Failed to fetch room data.",
      });
    }
  });

  // 좌석 선택 처리
  socket.on("selectSeat", async ({ seatId, eventId, eventDateId }) => {
    const roomName = `${eventId}_${eventDateId}`;

    // Redis에서 좌석 정보 조회
    let seat = await getSeatFromRedis(roomName, seatId);
    if (!seat) {
      socket.emit("error", { message: "Invalid seat ID." });
      return;
    }

    // 이미 예매된 좌석인지 확인
    if (seat.reservations.length !== 0) {
      socket.emit("error", {
        message: "Seat is reserved and cannot be selected.",
      });
      return;
    }

    const currentTime = new Date().toISOString();

    // 이전에 선택한 좌석을 찾고 취소
    const allSeats = await getAllSeatsFromRedis(roomName);
    for (const s of allSeats) {
      if (s.selectedBy === socket.id && s.id !== seatId) {
        s.selectedBy = null;
        s.updatedAt = currentTime;
        s.expirationTime = null;

        // Redis 만료 키 제거
        await fastify.redis.del(`timer:${roomName}:${s.id}`);

        // Redis 업데이트
        await updateSeatInRedis(roomName, s.id, s);

        // 같은 room의 유저들에게 상태 변경 브로드캐스트
        io.to(roomName).emit("seatSelected", {
          seatId: s.id,
          selectedBy: null,
          updatedAt: s.updatedAt,
          expirationTime: null,
        });

        fastify.log.info(`Seat ${s.id} selection cancelled by ${socket.id}`);
      }
    }

    // 이미 다른 유저가 선택한 좌석인지 확인
    const expired = await isSeatExpired(roomName, seatId);
    if (seat.selectedBy && !expired) {
      socket.emit("error", {
        message: "Seat is already selected by another user.",
      });
      return;
    }

    // 선택
    seat.selectedBy = socket.id;
    seat.updatedAt = currentTime;
    seat.expirationTime = new Date(
      Date.now() + SELECTION_TIMEOUT
    ).toISOString();

    // Redis 업데이트
    await updateSeatInRedis(roomName, seatId, seat);
    await setSeatExpirationInRedis(roomName, seatId);

    // 같은 room의 유저들에게 상태 변경 브로드캐스트
    io.to(roomName).emit("seatSelected", {
      seatId,
      selectedBy: seat.selectedBy,
      updatedAt: seat.updatedAt,
      expirationTime: seat.expirationTime,
    });

    fastify.log.info(`Seat ${seatId} selected by ${socket.id}`);
  });

  // 연석 처리
  socket.on("requestAdjacentSeats", async ({ seatId, eventId,eventDateId, numberOfSeats }) => {
    const roomName = `${eventId}_${eventDateId}`;
    
    // Redis에서 좌석 정보 조회
    let selectedSeat = await getSeatFromRedis(roomName, seatId);
    if (!selectedSeat) {
      socket.emit("error", { message: "Invalid seat ID." });
      return;
    }

    // 이미 예매된 좌석인지 확인
    if (selectedSeat.reservations.length !== 0) {
      socket.emit("error", {
        message: "Seat is reserved and cannot be selected.",
      });
      return;
    }

    const currentTime = new Date().toISOString();

    // 이전에 선택한 좌석들을 찾고 취소
    const allSeats = await getAllSeatsFromRedis(roomName);
    for (const s of allSeats) {
      if (s.selectedBy === socket.id) {
        s.selectedBy = null;
        s.updatedAt = currentTime;
        s.expirationTime = null;

        // Redis 만료 키 제거
        await fastify.redis.del(`timer:${roomName}:${s.id}`);

        // Redis 업데이트
        await updateSeatInRedis(roomName, s.id, s);

        // 같은 room의 유저들에게 상태 변경 브로드캐스트
        io.to(roomName).emit("seatSelected", {
          seatId: s.id,
          selectedBy: null,
          updatedAt: s.updatedAt,
          expirationTime: null,
        });

        fastify.log.info(`Seat ${s.id} selection cancelled by ${socket.id}`);
      }
    }

    // 이미 다른 유저가 선택한 좌석인지 확인
    const expired = await isSeatExpired(roomName, seatId);
    if (selectedSeat.selectedBy && !expired) {
      socket.emit("error", {
        message: "Seat is already selected by another user.",
      });
      return;
    }

    // 가능한 좌석 찾기
    const adjacentSeats = findAdjacentSeats(allSeats, selectedSeat, numberOfSeats);
    // 가능한 좌석이 요청한 좌석 수보다 적으면 리턴
    if (adjacentSeats.length < numberOfSeats) {
      socket.emit("error", {
        message: "Not enough adjacent seats available",
      });
      return;
    }

    const result = [];
    for (const seat of adjacentSeats) {

      // 선택될 좌석 상태 변경
      const targetSeat = allSeats.find((s) => s.id === seat.id);
      if (targetSeat) {
        targetSeat.selectedBy = socket.id;
        targetSeat.updatedAt = currentTime;
        targetSeat.expirationTime = new Date(Date.now() + SELECTION_TIMEOUT).toISOString();
      }

      result.push({
        seatId: seat.id,
        selectedBy: socket.id,
        updatedAt: currentTime,
        expirationTime: new Date(
        Date.now() + SELECTION_TIMEOUT
      ).toISOString(),
      })
      
      fastify.log.info(`Seat ${seat.id} of an adjacent group selected by ${socket.id}`);

      await updateSeatInRedis(roomName, targetSeat.id, targetSeat);
      await setSeatExpirationInRedis(roomName, targetSeat.id);
    }

    // 같은 room의 유저들에게 상태 변경 브로드캐스트
    io.to(roomName).emit("adjacentSeatsSelected", result);
  })

  socket.on("reserveSeat", async ({ seatId, eventId, eventDateId }) => {
    try {
      const reservationInfo = await getSeatReservationStatus(
        eventId,
        eventDateId,
        seatId
      );

      if (!reservationInfo) {
        socket.emit("error", {
          message: "Failed to retrieve seat reservation status.",
        });
        return;
      }

      const roomName = `${eventId}_${eventDateId}`;

      // Redis에서 좌석 정보 조회
      let seat = await getSeatFromRedis(roomName, seatId);
      if (!seat) {
        socket.emit("error", { message: "Invalid seat ID." });
        return;
      }

      // 좌석이 이미 예약되었는지 확인
      if (seat.reservations.length > 0) {
        socket.emit("error", {
          message: "Seat is already reserved by another user.",
        });
        return;
      }

      const currentTime = new Date().toISOString();

      seat.selectedBy = null;
      seat.updatedAt = currentTime;
      seat.expirationTime = null;
      seat.reservedBy = socket.id;
      seat.reservations = reservationInfo.reservations;

      // Redis 업데이트
      await updateSeatInRedis(roomName, seatId, seat);

      // 같은 room의 유저들에게 상태 변경 브로드캐스트
      io.to(roomName).emit("seatSelected", {
        seatId: seat.id,
        selectedBy: seat.selectedBy,
        updatedAt: seat.updatedAt,
        expirationTime: seat.expirationTime,
        reservedBy: seat.reservedBy,
      });

      fastify.log.info(
        `Seat ${seatId} reserved by ${socket.id} in room ${roomName}`
      );
    } catch (error) {
      // 에러 처리
      fastify.log.error(`Error reserving seat: ${error.message}`);
      socket.emit("error", {
        message: "An unexpected error occurred while reserving the seat.",
      });
    }
  });

  socket.on("disconnect", async () => {
    fastify.log.info(`Client disconnected: ${socket.id}`);

    // 모든 room에 대해 좌석 선택 초기화
    const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id);
    for (const roomName of rooms) {
      const allSeats = await getAllSeatsFromRedis(roomName);
      for (const seat of allSeats) {
        if (seat.selectedBy === socket.id) {
          seat.selectedBy = null;
          seat.updatedAt = new Date().toISOString();
          seat.expirationTime = null;

          // Redis 업데이트
          await updateSeatInRedis(roomName, seat.id, seat);

          // 같은 room의 유저들에게 상태 변경 브로드캐스트
          io.to(roomName).emit("seatSelected", {
            seatId: seat.id,
            selectedBy: null,
            updatedAt: seat.updatedAt,
            expirationTime: null,
          });
        }
      }
    }
  });

  // 클라이언트가 room을 떠날 때 처리
  socket.on("leaveRoom", ({ eventId, eventDateId }) => {
    const roomName = `${eventId}_${eventDateId}`;
    socket.leave(roomName);
    fastify.log.info(`Client ${socket.id} left room: ${roomName}`);
  });
});

const findAdjacentSeats = (seats, selectedSeat, numberOfSeats) => {
  const area = selectedSeat.area;
  const selectedRow = selectedSeat.row;
  const selectedNumber = selectedSeat.number;

  // 예약되지 않은 좌석들과 선택되지 않은 좌석들만 필터링
  const availableSeats = seats.filter(
    (seat) => seat.reservations.length === 0 && seat.selectedBy === null
  );

  const result = [selectedSeat]; // 처음 선택한 좌석은 항상 포함

  let offset = 1;
  // 같은 행(row)에서 좌석 찾기
  while (result.length < numberOfSeats) {
    // 현재 offset에 따라 왼쪽과 오른쪽 좌석 번호 계산
    const positions = [
      { row: selectedRow, number: selectedNumber + offset }, // 오른쪽 좌석
      { row: selectedRow, number: selectedNumber - offset }, // 왼쪽 좌석
    ];

    let seatFound = false;

    for (const pos of positions) {
      if (result.length >= numberOfSeats) break;

      // 해당 위치에 좌석이 있는지 확인
      const seat = availableSeats.find(
        (s) =>
          s.area === area && // 같은 구역인지 확인
          s.row === pos.row && // 같은 행인지 확인
          s.number === pos.number && // 해당 좌석 번호인지 확인
          !result.includes(s) // 이미 선택된 좌석이 아닌지 확인
      );

      if (seat) {
        result.push(seat); // 좌석을 결과에 추가
        seatFound = true;
      }
    }

    if (!seatFound) break; // 더 이상 좌석을 찾지 못하면 종료

    offset++;
  }

  // 같은 행에서 충분한 좌석을 찾지 못한 경우, 다른 행에서 좌석 찾기
  if (result.length < numberOfSeats) {
    // 동일한 구역(area) 내의 모든 행(row) 가져오기
    const rowsInArea = [...new Set(
      availableSeats
        .filter(seat => seat.area === area)
        .map(seat => seat.row)
    )];

    // 현재 행을 제외하고, 행 번호의 차이에 따라 가까운 순서대로 정렬
    const sortedRows = rowsInArea
      .filter(r => r !== selectedRow)
      .sort((a, b) => Math.abs(a - selectedRow) - Math.abs(b - selectedRow));

    for (const row of sortedRows) {
      if (result.length >= numberOfSeats) break;

      offset = 0;
      while (result.length < numberOfSeats) {
        // 현재 offset에 따라 좌석 번호 계산
        const positions = [
          { row: row, number: selectedNumber + offset }, // 오른쪽 좌석
          { row: row, number: selectedNumber - offset }, // 왼쪽 좌석
        ];

        let seatFound = false;

        for (const pos of positions) {
          if (result.length >= numberOfSeats) break;

          // 해당 위치에 좌석이 있는지 확인
          const seat = availableSeats.find(
            (s) =>
              s.area === area && // 같은 구역인지 확인
              s.row === pos.row && // 해당 행인지 확인
              s.number === pos.number && // 해당 좌석 번호인지 확인
              !result.includes(s) // 이미 선택된 좌석이 아닌지 확인
          );

          if (seat) {
            result.push(seat); // 좌석을 결과에 추가
            seatFound = true;
          }
        }

        if (!seatFound) break; // 더 이상 좌석을 찾지 못하면 종료

        offset++;
      }
    }
  }

  // 아직도 좌석을 다 찾지 못한 경우, 동일한 구역 내의 다른 좌석들을 추가
  if (result.length < numberOfSeats) {
    // 남은 좌석들을 거리 순으로 정렬
    const remainingSeats = availableSeats
      .filter(seat => seat.area === area && !result.includes(seat))
      .sort((a, b) => {
        const rowDiff = Math.abs(a.row - selectedRow) - Math.abs(b.row - selectedRow);
        if (rowDiff !== 0) return rowDiff;
        return Math.abs(a.number - selectedNumber) - Math.abs(b.number - selectedNumber);
      });

    for (const seat of remainingSeats) {
      if (result.length >= numberOfSeats) break;
      result.push(seat); // 좌석을 결과에 추가
    }
  }

  return result; // 최종 좌석 리스트 반환
};

const startServer = async () => {
  try {
    const port = Number(fastify.config.PORT);
    const address = await fastify.listen({ port, host: "0.0.0.0" });

    fastify.log.info(`Server is now listening on ${address}`);

    if (process.send) {
      process.send("ready");
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

let shutdownInProgress = false; // 중복 호출 방지 플래그

async function gracefulShutdown(signal) {
  if (shutdownInProgress) {
    fastify.log.warn(
      `Shutdown already in progress. Ignoring signal: ${signal}`
    );
    return;
  }
  shutdownInProgress = true; // 중복 호출 방지

  fastify.log.info(`Received signal: ${signal}. Starting graceful shutdown...`);

  try {
    io.sockets.sockets.forEach((socket) => {
      socket.disconnect(true);
    });
    fastify.log.info("All Socket.IO connections have been closed.");

    await fastify.close();
    fastify.log.info("Fastify server has been closed.");

    // 기타 필요한 종료 작업 (예: DB 연결 해제)
    // await database.disconnect();
    fastify.log.info("Additional cleanup tasks completed.");

    fastify.log.info("Graceful shutdown complete. Exiting process...");
    process.exit(0);
  } catch (error) {
    fastify.log.error("Error occurred during graceful shutdown:", error);
    process.exit(1);
  }
}

startServer();

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));