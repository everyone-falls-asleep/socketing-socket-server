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
import fastifyRabbit from "fastify-rabbitmq";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const SELECTION_TIMEOUT = 10 * 1000; // 선택 만료 시간: 10초
const RESERVATION_STATUS_INTERVAL = 1 * 1000; // 좌석 예매 현황 불러오는 주기: 1초
const PAYMENT_TIMEOUT = 60 * 1000; // 결제 만료 시간: 1분 (테스트용)

const schema = {
  type: "object",
  required: [
    "PORT",
    "JWT_SECRET",
    "JWT_SECRET_FOR_ENTRANCE",
    "CACHE_HOST",
    "CACHE_PORT",
    "DB_URL",
    "MQ_URL",
  ],
  properties: {
    PORT: {
      type: "string",
    },
    JWT_SECRET: {
      type: "string",
    },
    JWT_SECRET_FOR_ENTRANCE: {
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
    MQ_URL: {
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

await fastify.register(fastifyRabbit, {
  connection: fastify.config.MQ_URL,
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
    let rabbitStatus = { status: "disconnected", message: "" };

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
    let client;
    try {
      client = await fastify.pg.connect();
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

    // RabbitMQ 상태 확인
    try {
      if (fastify.rabbitmq.ready) {
        rabbitStatus = {
          status: "connected",
          message: "RabbitMQ is connected and operational.",
        };
      } else {
        rabbitStatus.message = "RabbitMQ is not connected.";
      }
    } catch (error) {
      rabbitStatus.message = `RabbitMQ connection check failed: ${error.message}`;
    }

    // 모든 상태가 정상일 때
    if (
      redisStatus.status === "connected" &&
      dbStatus.status === "connected" &&
      rabbitStatus.status === "connected"
    ) {
      reply.send({
        status: "ok",
        message: "The server is ready.",
        redis: redisStatus,
        database: dbStatus,
        rabbitmq: rabbitStatus,
      });
    } else {
      // 하나라도 비정상일 때
      reply.status(500).send({
        status: "error",
        message: "The server is not fully ready. See details below.",
        redis: redisStatus,
        database: dbStatus,
        rabbitmq: rabbitStatus,
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

// 이벤트에 대한 모든 구역 정보를 가져오는 함수
async function getAreasForRoom(eventId) {
  // PostgreSQL 쿼리 실행
  const query = `
    SELECT
      area.id,
      area.label,
      area.svg,
      area.price
    FROM area
    WHERE area."eventId" = $1
      AND area."deletedAt" IS NULL;
  `;
  const params = [eventId];

  const { rows } = await fastify.pg.query(query, params);

  // 구역 정보를 반환
  return rows;
}

async function getSeatsForArea(eventDateId, areaId) {
  // PostgreSQL 쿼리 실행
  const query = `
    SELECT
      seat.id AS seat_id,
      seat.cx,
      seat.cy,
      seat.row,
      seat.number,
      seat."areaId" AS area_id,
      reservation.id AS reservation_id,
      eventDate.id AS event_date_id,
      eventDate.date,
      "order"."userId" AS reserved_user_id
    FROM seat
    LEFT JOIN reservation ON reservation."seatId" = seat.id AND reservation."canceledAt" IS NULL AND reservation."deletedAt" IS NULL
    LEFT JOIN event_date AS eventDate ON reservation."eventDateId" = eventDate.id
    LEFT JOIN "order" ON reservation."orderId" = "order".id AND "order"."canceledAt" IS NULL AND "order"."deletedAt" IS NULL
    WHERE seat."areaId" = $1
      AND (eventDate.id = $2 OR eventDate.id IS NULL);
  `;
  const params = [areaId, eventDateId];

  const { rows } = await fastify.pg.query(query, params);

  // 데이터 가공
  const seatMap = new Map();

  rows.forEach((row) => {
    if (!seatMap.has(row.seat_id)) {
      seatMap.set(row.seat_id, {
        id: row.seat_id,
        cx: row.cx,
        cy: row.cy,
        row: row.row,
        number: row.number,
        area_id: row.area_id,
        selectedBy: null,
        reservedUserId: row.reserved_user_id || null, // 예약된 유저 ID
        updatedAt: null, // 초기 상태
        expirationTime: null, // 초기 상태
      });
    }
  });

  return Array.from(seatMap.values());
}

// Redis에서 구역 정보를 저장
// async function setAreaDataInRedis(roomName, areaData) {
//   await fastify.redis.set(`areaData:${roomName}`, JSON.stringify(areaData));
// }

// 구역 별 예약 상태를 Redis에 저장
async function updateAreaInRedis(roomName, areaId, area) {
  await fastify.redis.hset(`areas:${roomName}`, areaId, JSON.stringify(area));
}

// Redis에서 구역 별 예약 상태 가져오기
async function getAreaFromRedis(roomName, areaId) {
  const areaData = await fastify.redis.hget(`areas:${roomName}`, areaId);
  return areaData ? JSON.parse(areaData) : null;
}

// Redis에서 모든 구역 가져오기
async function getAllAreasFromRedis(roomName) {
  const areasData = await fastify.redis.hgetall(`areas:${roomName}`);
  const areas = [];
  for (const areaId in areasData) {
    areas.push(JSON.parse(areasData[areaId]));
  }
  return areas;
}

// Redis에서 좌석 정보를 구역 별로 저장
// async function setSeatDataInRedis(areaName, seatData) {
//   await fastify.redis.set(`seatData:${areaName}`, JSON.stringify(seatData));
// }

// 좌석 선택 상태를 Redis에 저장
async function updateSeatInRedis(areaName, seatId, seat) {
  await fastify.redis.hset(`seats:${areaName}`, seatId, JSON.stringify(seat));
}

// Redis에서 좌석 선택 상태 가져오기
async function getSeatFromRedis(areaName, seatId) {
  const seatData = await fastify.redis.hget(`seats:${areaName}`, seatId);
  return seatData ? JSON.parse(seatData) : null;
}

// Redis에서 특정 구역의 모든 좌석 가져오기
async function getAllSeatsFromRedis(areaName) {
  const seatsData = await fastify.redis.hgetall(`seats:${areaName}`);
  const seats = [];
  for (const seatId in seatsData) {
    seats.push(JSON.parse(seatsData[seatId]));
  }
  return seats;
}

// 좌석 선택 만료를 Redis에서 설정
async function setSeatExpirationInRedis(areaName, seatId) {
  // 만료 시간을 설정하여 키를 설정
  await fastify.redis.set(
    `timer:${areaName}:${seatId}`,
    "active",
    "PX",
    SELECTION_TIMEOUT
  );
}

// Redis에서 좌석 선택 만료 확인
async function isSeatExpired(areaName, seatId) {
  const status = await fastify.redis.exists(`timer:${areaName}:${seatId}`);
  return !status; // 존재하지 않으면 만료됨
}

// 새로운 Order를 Redis에 임시 저장
async function createOrderInRedis(areaName, seatIds, userId, eventDateId) {
  let id = crypto.randomUUID();
  const orderStatus = "pending"; // 초기 상태
  const createdAt = new Date().toISOString();

  // Redis에 Order 데이터 저장
  await fastify.redis.hset(
    `order:${areaName}`,
    id,
    JSON.stringify({ userId, eventDateId, seatIds, orderStatus, createdAt })
  );
  return id;
}

async function updateOrderInRedis(areaName, orderId) {
  try {
    // Redis에서 주문 데이터를 가져옴
    const orderData = await getOrderFromRedis(areaName, orderId);

    // 주문 데이터가 존재하지 않는 경우 예외 처리
    if (!orderData) {
      throw new Error(
        `Order not found in Redis for area: ${areaName}, orderId: ${orderId}`
      );
    }

    // 상태 업데이트
    orderData.orderStatus = "completed";

    // 업데이트된 데이터를 Redis에 저장
    await fastify.redis.hset(
      `order:${areaName}`,
      orderId,
      JSON.stringify(orderData)
    );

    // 업데이트 결과 확인
    const updatedRedisOrder = await getOrderFromRedis(areaName, orderId);
    return updatedRedisOrder;
  } catch (error) {
    console.error("Error updating order in Redis:", error);
    throw error; // 예외를 호출자로 전달
  }
}

// Redis에서 임시 주문 정보 가져오기
async function getOrderFromRedis(areaName, orderId) {
  const orderData = await fastify.redis.hget(`order:${areaName}`, orderId);
  return orderData ? JSON.parse(orderData) : null;
}

// 주문 결제 만료를 Redis에서 설정
async function setPaymentExpirationInRedis(areaName, orderId) {
  // 만료 시간을 설정하여 키를 설정
  await fastify.redis.set(
    `paymentTimer:${areaName}:${orderId}`,
    "active",
    "PX",
    PAYMENT_TIMEOUT
  );
}

// // Redis에서 주문 결제 만료 확인
// async function isPaymentExpired(areaName, orderId) {
//   const status = await fastify.redis.exists(`paymentTimer:${areaName}:${orderId}`);
//   return !status; // 존재하지 않으면 만료됨
// }

async function validateToken(token) {
  const status = await fastify.redis.get(`token:${token}`);
  if (status === "issued") {
    await fastify.redis.del(`token:${token}`); // 토큰 사용 완료 처리
    return true;
  }
  return false;
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
  const keyType = keyParts[0];
  if (keyType === "timer") {
    const areaName = keyParts[1];
    const seatId = keyParts[2];

    await handleExpirationEvent(areaName, seatId);
  } else if (keyType === "paymentTimer") {
    const areaName = keyParts[1];
    const orderId = keyParts[2];

    const orderData = await getOrderFromRedis(areaName, orderId);
    if (orderData && orderData.orderStatus === "pending") {
      for (const seatId of orderData.seatIds) {
        await handleExpirationEvent(areaName, seatId);
      }
    }
    await fastify.redis.hdel(`order:${areaName}`, orderId);
  }
});

// Redis 잠금을 사용하여 이벤트 중복 방지
const handleExpirationEvent = async (areaName, seatId) => {
  const lockKey = `lock:seat:${areaName}:${seatId}`;

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
    const seat = await getSeatFromRedis(areaName, seatId);
    if (seat) {
      seat.selectedBy = null;
      seat.updatedAt = new Date().toISOString();
      seat.expirationTime = null;
      seat.reservedUserId = null;

      await updateSeatInRedis(areaName, seatId, seat);

      io.to(areaName).emit("seatsSelected", [
        {
          seatId: seat.id,
          selectedBy: null,
          updatedAt: seat.updatedAt,
          expirationTime: null,
          reservedUserId: null,
        },
      ]);

      fastify.log.info(
        `Selection for seat ${seatId} has expired (area: ${areaName}).`
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
  adapter: createAdapter(pubClient, subClient),
});

instrument(io, {
  auth: {
    type: "basic",
    username: "admin",
    password: "$2a$10$QWUn5UhhE3eSAu2a95fVn.PRVaamlJlJBMeT7viIrvgvfCOeUIV2W",
  },
  mode: "development",
});

// Redis 기반 유저 수 가져오기 함수
async function getRoomUserCount(roomName) {
  const maxRetries = 30;
  let delay = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // const sockets = await io.in(roomName).fetchSockets(); // 모든 노드에서 룸에 속한 소켓 ID 가져오기
      const count = await fastify.redis.get(`room:${roomName}:count`);
      return parseInt(count || "0"); // 소켓 수 반환
    } catch (err) {
      console.error(
        `Timeout reached, retrying (attempt ${attempt}/${maxRetries})...`
      );
      await new Promise((resolve) => {
        delay = decorrelatedJitter(100, 60000, delay);
        setTimeout(resolve, delay);
      });
    }
  }
}

async function decrementRoomCount(room) {
  const decrementScript = `
  local key = KEYS[1]
  local value = redis.call("GET", key)
  if value and tonumber(value) > 0 then
    return redis.call("DECR", key)
  else
    return 0
  end
`;
  const key = `room:${room}:count`;
  const count = await fastify.redis.eval(decrementScript, 1, key);
  return parseInt(count || "0");
}

function decorrelatedJitter(baseDelay, maxDelay, previousDelay) {
  if (!previousDelay) {
    previousDelay = baseDelay;
  }
  return Math.min(
    maxDelay,
    Math.random() * (previousDelay * 3 - baseDelay) + baseDelay
  );
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error("Authentication error"));
  }

  if (!(await validateToken(token))) {
    return next(new Error("Authentication error 2"));
  }

  try {
    const decoded = jwt.verify(token, fastify.config.JWT_SECRET_FOR_ENTRANCE);
    socket.data.user = decoded;
    next();
  } catch (err) {
    return next(new Error("Authentication error"));
  }
});

// const roomIntervals = {};
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

    try {
      // Room 접속자가 최대치를 초과하면 연결 거부
      // if (currentConnections >= MAX_ROOM_CONNECTIONS) {
      //   socket.emit("error", {
      //     message: `Room ${roomName} is full. Maximum connections reached.`,
      //   });
      //   return;
      // }

      // 클라이언트를 해당 room에 추가
      socket.join(roomName);
      const currentConnections = await fastify.redis.incr(
        `room:${roomName}:count`
      );

      fastify.log.info(
        `Client ${socket.id} joined room: ${roomName}. Current connections: ${currentConnections + 1}`
      );

      // 구역 정보 가져오기
      let areas = await getAllAreasFromRedis(roomName);
      if (areas.length === 0) {
        // Redis에 구역 정보가 없으면 DB에서 가져오기
        areas = await getAreasForRoom(eventId, eventDateId); // DB에서 가져오기
        // Redis에 구역 정보 저장
        for (const area of areas) {
          await updateAreaInRedis(roomName, area.id, area);
        }
        // await setAreaDataInRedis(roomName, areas);
      }

      // 클라이언트에게 데이터 전송
      socket.emit("roomJoined", {
        message: `You have joined the room: ${roomName}`,
        areas,
      });

      // startReservationStatusInterval(eventId, eventDateId);

      const jwtToken = jwt.sign(
        {
          jti: crypto.randomUUID(),
          sub: "scheduling",
          eventId,
          eventDateId,
        },
        fastify.config.JWT_SECRET,
        {
          expiresIn: 600, // 10분
        }
      );

      await fetch(
        "https://socketing.hjyoon.me/scheduling/seat/reservation/statistic",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwtToken}`, // JWT 토큰 추가
          },
        }
      );
    } catch (error) {
      fastify.log.error(`Error fetching data for room ${roomName}:`, error);
      socket.emit("error", {
        message: "Failed to fetch room data.",
      });
    }
  });

  socket.on("joinArea", async ({ eventId, eventDateId, areaId }) => {
    if (!eventId || !eventDateId || !areaId) {
      socket.emit("error", { message: "Invalid area parameters." });
      return;
    }

    const areaName = `${eventId}_${eventDateId}_${areaId}`;

    try {
      // 클라이언트를 해당 area에 추가
      socket.join(areaName);

      fastify.log.info(`Client ${socket.id} joined area: ${areaName}.`);

      // 좌석 정보 가져오기
      let seats = await getAllSeatsFromRedis(areaName);
      if (seats.length === 0) {
        // Redis에 좌석 정보가 없으면 DB에서 가져오기
        seats = await getSeatsForArea(eventDateId, areaId); // DB에서 가져오기
        // Redis에 좌석 정보 저장
        for (const seat of seats) {
          await updateSeatInRedis(areaName, seat.id, seat);
        }
        // await setSeatDataInRedis(areaName, seats);
      }

      // 클라이언트에게 데이터 전송
      socket.emit("areaJoined", {
        message: `You have joined the area: ${areaName}`,
        seats,
      });
    } catch (error) {
      fastify.log.error(`Error fetching data for area ${areaName}:`, error);
      socket.emit("error", {
        message: "Failed to fetch area data.",
      });
    }
  });

  // 좌석 선택 처리 (단일 및 연석)
  socket.on(
    "selectSeats",
    async ({ seatId, eventId, eventDateId, areaId, numberOfSeats = 1 }) => {
      const areaName = `${eventId}_${eventDateId}_${areaId}`;

      // Redis에서 모든 좌석 정보 조회
      const allSeats = await getAllSeatsFromRedis(areaName);

      // 이전에 선택한 좌석들을 찾고 취소
      await releaseSeats(socket.id, allSeats, areaName);

      // 선택하려는 좌석 찾기
      const selectedSeat = allSeats.find((s) => s.id === seatId);
      if (!selectedSeat) {
        socket.emit("error", { message: "Invalid seat ID." });
        return;
      }

      const seatsToSelect = [];

      if (numberOfSeats === 1) {
        // 단일 좌석 선택

        // 이미 예매된 좌석인지 확인
        if (selectedSeat.reservedUserId) {
          socket.emit("error", {
            message: `Seat ${selectedSeat.id} is reserved and cannot be selected.`,
          });
          return;
        }

        // 이미 다른 유저가 선택한 좌석인지 확인
        const expired = await isSeatExpired(areaName, selectedSeat.id);
        if (selectedSeat.selectedBy && !expired) {
          socket.emit("error", {
            message: `Seat ${selectedSeat.id} is already selected by another user.`,
          });
          return;
        }

        seatsToSelect.push(selectedSeat);
      } else {
        // 연석 선택
        const adjacentSeats = findAdjacentSeats(
          allSeats,
          selectedSeat,
          numberOfSeats
        );

        // 가능한 좌석이 요청한 좌석 수보다 적으면 리턴
        if (adjacentSeats.length < numberOfSeats) {
          socket.emit("error", {
            message: "Not enough adjacent seats available",
          });
          return;
        }
        seatsToSelect.push(...adjacentSeats);
      }

      const currentTime = new Date().toISOString();
      const result = [];
      for (const seat of seatsToSelect) {
        // 선택될 좌석 상태 변경
        seat.selectedBy = socket.id;
        seat.updatedAt = currentTime;
        seat.expirationTime = new Date(
          Date.now() + SELECTION_TIMEOUT
        ).toISOString();

        // Redis 업데이트
        await updateSeatInRedis(areaName, seat.id, seat);
        await setSeatExpirationInRedis(areaName, seat.id);

        result.push({
          seatId: seat.id,
          selectedBy: socket.id,
          updatedAt: currentTime,
          expirationTime: seat.expirationTime,
        });

        fastify.log.info(`Seat ${seat.id} selected by ${socket.id}`);
      }

      // 같은 room의 유저들에게 상태 변경 브로드캐스트
      io.to(areaName).emit("seatsSelected", result);
    }
  );

  socket.on(
    "reserveSeats",
    async ({ seatIds, eventId, eventDateId, areaId, userId }) => {
      const roomName = `${eventId}_${eventDateId}`;
      const areaName = `${eventId}_${eventDateId}_${areaId}`;
      const seatsToReserve = [];
      const broadcastUpdates = [];
      const seatIdsToReserve = [];

      try {
        if (!Array.isArray(seatIds) || seatIds.length === 0) {
          socket.emit("error", { message: "Invalid seat IDs." });
          return;
        }

        for (const seatId of seatIds) {
          // Redis에서 좌석 정보 조회
          let seat = await getSeatFromRedis(areaName, seatId);
          if (!seat) {
            fastify.log.warn(`Invalid seat ID: ${seatId}`);
            socket.emit("error", { message: `Invalid seat ID: ${seatId}.` });
            return;
          }

          // 좌석이 이미 예약되었는지 확인
          if (seat.reservedUserId) {
            socket.emit("error", {
              message: `Seat ${seat.id} is reserved and cannot be selected.`,
            });
            return;
          }

          // 이미 다른 유저가 선택한 좌석인지 확인
          const expired = await isSeatExpired(areaName, seat.id);
          if (
            seat.selectedBy !== null &&
            seat.selectedBy !== socket.id &&
            !expired
          ) {
            socket.emit("error", {
              message: `Seat ${seat.id} is already selected by another user.`,
            });
            return;
          }

          const currentTime = new Date().toISOString();

          // 좌석 상태 업데이트
          seat.reservedUserId = userId;
          seat.selectedBy = null;
          seat.updatedAt = currentTime;
          seat.expirationTime = null;

          // Redis 업데이트
          await updateSeatInRedis(areaName, seatId, seat);
          fastify.log.info(
            `Seat ${seatId} will be reserved by ${socket.id} in area ${areaName}`
          );

          await fastify.redis.del(`timer:${areaName}:${seatId}`); // seat expiration timer 삭제

          seatsToReserve.push(seat);
          seatIdsToReserve.push(seat.id);

          // 브로드캐스트 업데이트에 추가
          broadcastUpdates.push({
            seatId: seat.id,
            selectedBy: seat.selectedBy,
            updatedAt: seat.updatedAt,
            expirationTime: seat.expirationTime,
            reservedUserId: seat.reservedUserId,
          });
        }
      } catch (error) {
        fastify.log.error(
          `Failed to process seat ${seat.id}: ${error.message}`
        );
        socket.emit("error", {
          message: `Failed to process seat ${seat.id}: ${error.message}`,
        });
      }

      let orderId;
      try {
        orderId = await createOrderInRedis(
          areaName,
          seatIdsToReserve,
          userId,
          eventDateId
        );
        await setPaymentExpirationInRedis(areaName, orderId);
        const order = await getOrderFromRedis(areaName, orderId);
        const selectedArea = await getAreaFromRedis(roomName, areaId);

        const area = {
          id: selectedArea.id,
          label: selectedArea.label,
          price: selectedArea.price,
        };
        const expirationTime = new Date(
          Date.now() + PAYMENT_TIMEOUT
        ).toISOString();

        const reservationData = {
          id: orderId,
          createdAt: order.createdAt,
          expirationTime: expirationTime,
          seats: seatsToReserve,
          area: area,
        };

        // 클라이언트에게 주문 정보 전달
        socket.emit("orderMade", { data: reservationData });
      } catch (error) {
        fastify.log.error(`Failed to prepare order data: ${error.message}`);
        socket.emit("error", {
          message: `Failed to prepare order data: ${error.message}`,
        });
      }

      // 같은 room의 유저들에게 상태 변경 브로드캐스트
      if (broadcastUpdates.length > 0) {
        io.to(areaName).emit("seatsSelected", broadcastUpdates);
      }
    }
  );

  socket.on(
    "requestOrder",
    async ({
      userId,
      orderId,
      paymentMethod,
      eventId,
      eventDateId,
      areaId,
    }) => {
      if (
        !userId ||
        !orderId ||
        !paymentMethod ||
        !eventId ||
        !eventDateId ||
        !areaId
      ) {
        socket.emit("error", { message: "Invalid requestOrder parameters." });
        return;
      }
      const areaName = `${eventId}_${eventDateId}_${areaId}`;

      const redisOrderData = await getOrderFromRedis(areaName, orderId);
      if (!redisOrderData) {
        socket.emit("error", { message: "Invalid cache requestOrderData" });
        return;
      }

      const client = await fastify.pg.connect();
      try {
        await client.query("BEGIN");

        // 사용자 검증
        const userResult = await client.query(
          `SELECT * FROM "user" WHERE id = $1`,
          [userId]
        );
        const user = userResult.rows[0];
        if (!user) {
          throw { code: "USER_NOT_FOUND", message: "User not found." };
        }

        // EventDate 및 Event 검증
        const eventResult = await client.query(
          `
            SELECT
              ed.id AS "eventDateId",
              ed.date AS "eventDate",
              e.id AS "eventId",
              e.title AS "eventTitle",
              e.place AS "eventPlace",
              e.cast AS "eventCast",
              e.thumbnail AS "eventThumbnail",
              e."ageLimit" AS "eventAgeLimit"
            FROM event_date ed
            INNER JOIN event e ON ed."eventId" = e.id
            WHERE ed.id = $1
          `,
          [eventDateId]
        );

        // 결과 처리
        const event = eventResult.rows[0];
        if (!event) {
          throw {
            code: "EVENT_DATE_NOT_FOUND",
            message: "Event date not found.",
          };
        }

        const seatIds = redisOrderData.seatIds;
        const seatResult = await client.query(
          `
          SELECT
            s.*,
            a.id AS "areaId",
            a.label AS "areaLabel",
            a.price AS "areaPrice"
          FROM seat s
          INNER JOIN area a ON s."areaId" = a.id
          WHERE s.id = ANY($1::uuid[])
        `,
          [seatIds]
        );

        // Seat 배열 생성
        const seatsArray = seatResult.rows;

        // 예약 여부 검증
        for (const seatId of seatIds) {
          const reservationCheck = await client.query(
            `
            SELECT *
            FROM reservation r
            LEFT JOIN "order" o ON r."orderId" = "o".id
            WHERE "eventDateId" = $1
            AND r."seatId" = $2
            AND r."canceledAt" IS NULL
            AND r."deletedAt" IS NULL
            AND o."canceledAt" IS NULL
          `,
            [eventDateId, seatId]
          );
          if (reservationCheck.rows.length > 0) {
            throw {
              code: "EXISTING_ORDER",
              message: `Seat ${seatId} is already reserved.`,
            };
          }
        }

        // 주문 생성
        // order를 생성하고 반환된 orderId를 사용
        const pgOrderResult = await client.query(
          `
            INSERT INTO "order" ("userId", "paymentMethod")
            VALUES ($1, $2)
            RETURNING id
          `,
          [userId, paymentMethod]
        );

        const pgSavedOrder = pgOrderResult.rows[0];
        const pgSavedOrderId = pgSavedOrder.id;

        // reservation 테이블에 다중 row 삽입
        for (const seatId of seatIds) {
          const reservationParam = {
            pgSavedOrderId,
            eventDateId,
            seatId,
          };

          const query = `
            INSERT INTO reservation ("orderId", "eventDateId", "seatId")
            VALUES ($1, $2, $3)
          `;

          await client.query(query, [
            reservationParam.pgSavedOrderId,
            reservationParam.eventDateId,
            reservationParam.seatId,
          ]);
        }

        // 총 금액 계산
        const totalAmountResult = await client.query(
          `
          SELECT SUM(area.price) AS "totalAmount"
          FROM reservation
          INNER JOIN seat ON reservation."seatId" = seat.id
          INNER JOIN area AS area ON seat."areaId" = area.id
          WHERE reservation."eventDateId" = $1
            AND reservation."orderId" = $2
        `,
          [eventDateId, pgSavedOrderId]
        );

        const totalAmount = Number(totalAmountResult.rows[0]?.totalAmount || 0);

        if (isNaN(totalAmount)) {
          throw { code: "INVALID_AMOUNT", message: "Invalid total amount." };
        }

        // 포인트 차감
        if (user.point < totalAmount) {
          throw {
            code: "INSUFFICIENT_BALANCE",
            message: "Insufficient balance.",
          };
        }
        await client.query(
          `UPDATE "user" SET point = point - $1 WHERE id = $2`,
          [totalAmount, userId]
        );

        // 응답 데이터 구성
        const responseData = {
          orderId: pgSavedOrder.id,
          orderCreatedAt: pgSavedOrder.createdAt,
          orderUpdatedAt: pgSavedOrder.updatedAt,
          orderCanceledAt: pgSavedOrder.canceledAt,
          paymentMethod: pgSavedOrder.paymentMethod,
          useId: user.id,
          userNickname: user.nickname,
          userEmail: user.email,
          userProfileImage: user.profileImage,
          userRole: user.role,
          eventId: event.eventId,
          eventTitle: event.eventTitle,
          eventPlace: event.eventPlace,
          eventCast: event.eventCast,
          eventDate: event.eventDate,
          eventThumbnail: event.eventThumbnail,
          eventAgeLimit: event.eventAgeLimit,
          reservations: seatsArray.map((seat) => ({
            seatId: seat.id,
            seatRow: seat.row,
            seatNumber: seat.number,
            seatAreaId: seat.areaId,
            seatAreaLabel: seat.areaLabel,
            seatPrice: seat.areaPrice,
          })),
        };

        await client.query("COMMIT"); // 트랜잭션 커밋

        await updateOrderInRedis(areaName, orderId);

        socket.emit("orderApproved", { success: true, data: responseData });
      } catch (error) {
        await client.query("ROLLBACK"); // 트랜잭션 롤백
        console.error("Error processing order request:", error);

        // 에러 응답 전송
        socket.emit("error", {
          error: error.code || "UNKNOWN_ERROR",
          message: error.message || "An unexpected error occurred.",
        });
      } finally {
        client.release(); // PostgreSQL 클라이언트 연결 해제
      }
    }
  );

  socket.on("exitArea", async ({ eventId, eventDateId, areaId }) => {
    if (!eventId || !eventDateId || !areaId) {
      socket.emit("error", { message: "Invalid area parameters." });
      return;
    }

    const areaName = `${eventId}_${eventDateId}_${areaId}`;

    try {
      socket.leave(areaName);
      // 클라이언트에게 데이터 전송
      socket.emit("areaExited", {
        message: `You have left the area: ${areaName}`,
      });

      const allSeats = await getAllSeatsFromRedis(areaName);
      await releaseSeats(socket.id, allSeats, areaName);

      fastify.log.info(`Client ${socket.id} left area: ${areaName}.`);
    } catch (error) {
      fastify.log.error(`Error exiting area ${areaName}:`, error);
      socket.emit("error", {
        message: "Failed to leave current area.",
      });
    }
  });

  socket.on("exitRoom", async ({ eventId, eventDateId }) => {
    if (!eventId || !eventDateId) {
      socket.emit("error", { message: "Invalid room parameters." });
      return;
    }

    const roomName = `${eventId}_${eventDateId}`;

    try {
      socket.leave(roomName);
      // 클라이언트에게 데이터 전송
      socket.emit("roomExited", {
        message: `You have left the room: ${roomName}`,
      });

      fastify.log.info(`Client ${socket.id} left room: ${roomName}.`);
    } catch (error) {
      fastify.log.error(`Error exiting area ${areaName}:`, error);
      socket.emit("error", {
        message: "Failed to leave current area.",
      });
    }
  });

  // 클라이언트 연결 해제 처리
  socket.on("disconnect", async () => {
    fastify.log.info(`Client disconnected: ${socket.id}`);
  });
});

// 클라이언트가 Room을 떠날 때 처리
io.of("/").adapter.on("leave-room", async (room, id) => {
  if (room != id) {
    await decrementRoomCount(room);
    io.serverSideEmit("leave-room", { room, id });
    const socket = io.sockets.sockets.get(id);
    if (socket) {
      await handleClientLeave(socket, room);
    }
  }
});

async function releaseSeats(socketId, seats, areaName) {
  const currentTime = new Date().toISOString();
  const seatsToRelease = [];

  for (const seat of seats) {
    if (seat.selectedBy === socketId) {
      seat.selectedBy = null;
      seat.updatedAt = currentTime;
      seat.expirationTime = null;
      seat.reservedUserId = null;

      seatsToRelease.push({
        seatId: seat.id,
        selectedBy: seat.selectedBy,
        updatedAt: seat.updatedAt,
        expirationTime: seat.expirationTime,
        reservedUserId: seat.reservedUserId,
      });

      await fastify.redis.del(`timer:${areaName}:${seat.id}`); // Redis 만료 키 제거

      // Redis 업데이트
      await updateSeatInRedis(areaName, seat.id, seat);

      // 같은 area의 유저들에게 상태 변경 브로드캐스트

      fastify.log.info(`Seat ${seat.id} selection cancelled by ${socketId}`);
    }
  }
  if (seatsToRelease.length > 0) {
    io.to(areaName).emit("seatsSelected", seatsToRelease);
  }
}

// RabbitMQ 메시지 전송 로직
async function sendMessageToQueue(roomName, message) {
  const queueName = `queue:${roomName}`;
  try {
    // 큐 선언 (존재하지 않을 경우 생성)
    await fastify.rabbitmq.queueDeclare({ queue: queueName, durable: true });

    // Publisher 생성
    const publisher = fastify.rabbitmq.createPublisher({
      confirm: true, // 메시지가 성공적으로 전송되었는지 확인
      maxAttempts: 3, // 최대 재시도 횟수
    });

    // 메시지 전송
    await publisher.send(queueName, JSON.stringify(message));

    fastify.log.info(`Message sent to queue "${queueName}": ${message}`);
  } catch (error) {
    fastify.log.error(`Failed to send message to queue "${queueName}":`, error);
  }
}

// 공통 로직: 클라이언트가 Room을 떠날 때 처리
async function handleClientLeave(socket, roomName) {
  try {
    // Room의 현재 접속자 수 확인
    // const currentConnections =
    //   io.sockets.adapter.rooms.get(roomName)?.size || 0;
    // fastify.log.info(
    //   `Client ${socket.id} left room: ${roomName}. Current connections: ${currentConnections}/${MAX_ROOM_CONNECTIONS}`
    // );
    // 접속자가 최대치 아래로 떨어지면 RabbitMQ에 신호 전송
    // if (currentConnections < MAX_ROOM_CONNECTIONS) {
    //   await sendMessageToQueue(roomName, "allow");
    // }
    // 마지막 사용자인 경우 reservation interval 타이머 제거
    // if (roomIntervals[roomName]) {
    //   clearReservationStatusInterval(roomName);
    // }
  } catch (error) {
    fastify.log.error(
      `Error handling client leave for room ${roomName}:`,
      error
    );
  }
}

// function startReservationStatusInterval(eventId, eventDateId) {
//   const roomName = `${eventId}_${eventDateId}`;
//   // 만약 해당 room에 대한 타이머가 없다면 생성
//   if (!roomIntervals[roomName]) {
//     roomIntervals[roomName] = setInterval(async () => {
//       try {
//         // areas 및 areaStats 계산 로직
//         let areas = await getAllAreasFromRedis(roomName);
//         if (areas.length === 0) {
//           areas = await getAreasForRoom(eventId);
//           for (const area of areas) {
//             await updateAreaInRedis(roomName, area.id, area);
//           }
//         }

//         const areaStats = [];
//         for (const area of areas) {
//           const areaId = area.id;
//           const areaName = `${eventId}_${eventDateId}_${areaId}`;
//           let seats = await getAllSeatsFromRedis(areaName);
//           if (seats.length === 0) {
//             seats = await getSeatsForArea(eventDateId, areaId);
//             for (const seat of seats) {
//               await updateSeatInRedis(areaName, seat.id, seat);
//             }
//           }

//           const totalSeatsNum = seats.length;
//           const reservedSeatsNum = seats.filter(
//             (seat) => seat.reservedUserId !== null
//           ).length;
//           areaStats.push({
//             areaId: areaId,
//             totalSeatsNum: totalSeatsNum,
//             reservedSeatsNum: reservedSeatsNum,
//           });
//         }

//         // 해당 room에 통계 정보 전송
//         io.to(roomName).emit("reservedSeatsStatistic", areaStats);
//       } catch (error) {
//         fastify.log.error(
//           `Error emitting reservedSeatsStatistic: ${error.message}`
//         );
//       }
//     }, RESERVATION_STATUS_INTERVAL); // 2초마다 실행
//   }
// }

// async function clearReservationStatusInterval(roomName) {
//   try {
//     const currentConnections = await getRoomUserCount(roomName);
//     fastify.log.info(
//       `roomName: ${roomName}, currentConnections: ${currentConnections}`
//     );
//     if (currentConnections < 1 && roomIntervals[roomName]) {
//       clearInterval(roomIntervals[roomName]);
//       delete roomIntervals[roomName];
//       fastify.log.info(`Interval for room ${roomName} has been cleared.`);
//     }
//   } catch {
//     fastify.log.info(`Failed to clear Interval for room ${roomName}`);
//   }
// }

function findAdjacentSeats(seats, selectedSeat, numberOfSeats) {
  const selectedRow = selectedSeat.row;
  const selectedNumber = selectedSeat.number;

  // 예약되지 않은 좌석들과 선택되지 않은 좌석들만 필터링
  const availableSeats = seats.filter(
    (seat) => seat.reservedUserId === null && seat.selectedBy === null
  );

  const result = []; // 초기 배열을 비워둠

  // 중복 좌석 체크 함수
  const isSeatAlreadySelected = (seat) =>
    result.some((r) => r.row === seat.row && r.number === seat.number);

  // 초기 좌석 추가
  result.push(selectedSeat);

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
          s.row === pos.row && // 같은 행인지 확인
          s.number === pos.number && // 해당 좌석 번호인지 확인
          !isSeatAlreadySelected(s) // 중복 좌석 체크
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
    const rowsInArea = [...new Set(availableSeats.map((seat) => seat.row))];

    // 현재 행을 제외하고, 행 번호의 차이에 따라 가까운 순서대로 정렬
    const sortedRows = rowsInArea
      .filter((r) => r !== selectedRow)
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
              s.row === pos.row && // 해당 행인지 확인
              s.number === pos.number && // 해당 좌석 번호인지 확인
              !isSeatAlreadySelected(s) // 중복 좌석 체크
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
      .filter((seat) => !isSeatAlreadySelected(seat)) // 이미 선택된 좌석 제외
      .sort((a, b) => {
        const rowDiff =
          Math.abs(a.row - selectedRow) - Math.abs(b.row - selectedRow);
        if (rowDiff !== 0) return rowDiff;
        return (
          Math.abs(a.number - selectedNumber) -
          Math.abs(b.number - selectedNumber)
        );
      });

    for (const seat of remainingSeats) {
      if (result.length >= numberOfSeats) break;
      result.push(seat); // 좌석 추가
    }
  }

  return result;
}

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
