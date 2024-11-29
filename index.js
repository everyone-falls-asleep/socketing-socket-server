import Fastify from "fastify";
import { Server } from "socket.io";
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
const timers = new Map();

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

const io = new Server(fastify.server, {
  cors: {
    origin: "*",
    methods: "*",
    credentials: true,
  },
  transports: ["websocket"],
});

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
      if (!seatData[roomName]) {
        seatData[roomName] = await getSeatsForRoom(eventId, eventDateId); // DB에서 가져오기
      }

      // 클라이언트에게 데이터 전송
      socket.emit("roomJoined", {
        message: `You have joined the room: ${roomName}`,
        seats: seatData[roomName],
      });
    } catch (error) {
      fastify.log.error(`Error fetching data for room ${roomName}:`, error);
      socket.emit("error", {
        message: "Failed to fetch room data.",
      });
    }
  });

  // 좌석 선택 처리
  socket.on("selectSeat", ({ seatId, eventId, eventDateId }) => {
    const roomName = `${eventId}_${eventDateId}`;

    // 유효성 검사
    const seat = seatData[roomName]?.find((s) => s.id === seatId);
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
    const previouslySelectedSeat = seatData[roomName]?.find(
      (s) => s.selectedBy === socket.id
    );
    if (previouslySelectedSeat) {
      // 선택 취소
      previouslySelectedSeat.selectedBy = null;
      previouslySelectedSeat.updatedAt = currentTime;

      // 타이머가 있다면 취소
      if (timers.has(previouslySelectedSeat.id)) {
        clearTimeout(timers.get(previouslySelectedSeat.id));
        timers.delete(previouslySelectedSeat.id);
      }

      // 같은 room의 유저들에게 상태 변경 브로드캐스트
      io.to(roomName).emit("seatSelected", {
        seatId: previouslySelectedSeat.id,
        selectedBy: null,
        updatedAt: previouslySelectedSeat.updatedAt,
        expirationTime: null,
      });

      fastify.log.info(
        `Seat ${previouslySelectedSeat.id} selection cancelled by ${socket.id}`
      );
    }

    if (seat.selectedBy) {
      // 이미 다른 유저가 선택한 좌석
      socket.emit("error", {
        message: "Seat is already selected by another user.",
      });
      return;
    } else {
      // 선택
      seat.selectedBy = socket.id;
      seat.updatedAt = currentTime;
      seat.expirationTime = new Date(
        Date.now() + SELECTION_TIMEOUT
      ).toISOString();
      fastify.log.info(`Seat ${seatId} selected by ${socket.id}`);

      // 만료 타이머 설정
      const timer = setTimeout(() => {
        seat.selectedBy = null;
        seat.updatedAt = null;
        seat.expirationTime = null;

        // 상태 변경 브로드캐스트
        io.to(roomName).emit("seatSelected", {
          seatId: seat.id,
          selectedBy: null,
          updatedAt: new Date().toISOString(),
          expirationTime: null,
        });

        timers.delete(seat.id);
        fastify.log.info(`Seat ${seat.id} selection expired.`);
      }, SELECTION_TIMEOUT);

      timers.set(seat.id, timer);
    }

    // 같은 room의 유저들에게 상태 변경 브로드캐스트
    io.to(roomName).emit("seatSelected", {
      seatId,
      selectedBy: seat.selectedBy,
      updatedAt: seat.updatedAt,
      expirationTime: seat.expirationTime,
    });
  });

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

      // 유효성 검사
      const seat = seatData[roomName]?.find((s) => s.id === reservationInfo.id);
      if (!seat) {
        socket.emit("error", { message: "Invalid seat ID." });
        return;
      }

      // 좌석이 이미 예약되었는지 확인
      if (seat.reservedBy || seat.reservations.length > 0) {
        socket.emit("error", {
          message: "Seat is already reserved by another user.",
        });
        return;
      }

      // 타이머가 있다면 취소
      if (timers.has(seat.id)) {
        clearTimeout(timers.get(seat.id));
        timers.delete(seat.id);
      }

      const currentTime = new Date().toISOString();

      seat.selectedBy = null;
      seat.updatedAt = currentTime;
      seat.expirationTime = null;
      seat.reservedBy = socket.id;
      seat.reservations = reservationInfo.reservations;

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

  socket.on("disconnect", () => {
    fastify.log.info(`Client disconnected: ${socket.id}`);

    // 연결 해제된 유저가 선택한 좌석 초기화
    for (const roomName in seatData) {
      seatData[roomName].forEach((seat) => {
        if (seat.selectedBy === socket.id) {
          const currentTime = new Date().toISOString();
          seat.selectedBy = null;
          seat.updatedAt = currentTime;
          io.to(roomName).emit("seatSelected", {
            seatId: seat.id,
            selectedBy: null,
            updatedAt: currentTime,
            expirationTime: null,
          });
        }
      });
      // 모든 클라이언트가 떠났는지 확인 후 데이터 비우기
      checkAndClearRoomData(roomName);
    }
  });

  // Room의 클라이언트 연결 상태 확인 및 데이터 비우기
  const checkAndClearRoomData = (roomName) => {
    const room = io.sockets.adapter.rooms.get(roomName);
    if (!room || room.size === 0) {
      delete seatData[roomName];
      fastify.log.info(`Room ${roomName} is now empty. Cleared seat data.`);
    }
  };

  // 클라이언트가 room을 떠날 때 처리
  socket.on("leaveRoom", ({ eventId, eventDateId }) => {
    const roomName = `${eventId}_${eventDateId}`;
    socket.leave(roomName);
    fastify.log.info(`Client ${socket.id} left room: ${roomName}`);

    // 모든 클라이언트가 떠났는지 확인 후 데이터 비우기
    checkAndClearRoomData(roomName);
  });
});

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
