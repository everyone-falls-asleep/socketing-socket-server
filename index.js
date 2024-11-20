import Fastify from "fastify";
import { Server } from "socket.io";
import fastifyEnv from "@fastify/env";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyRedis from "@fastify/redis";
import fastifyPostgres from "@fastify/postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const canvasWidth = 800;
const canvasHeight = 600;
const radius = 20;
const canvasState = []; // 캔버스 상태를 저장할 배열
const SELECTION_TIMEOUT = 10 * 1000; // 선택 만료 시간: 10초
const timers = new Map(); // 각 원의 만료 타이머 관리

// 랜덤 원 생성 함수
function generateRandomCircles() {
  canvasState.length = 0; // 기존 상태 초기화
  let attempts = 0;

  while (canvasState.length < 10 && attempts < 1000) {
    const x = Math.random() * (canvasWidth - 2 * radius) + radius;
    const y = Math.random() * (canvasHeight - 2 * radius) + radius;

    // 원이 겹치지 않게 생성
    const isOverlapping = canvasState.some((circle) => {
      const dx = circle.x - x;
      const dy = circle.y - y;
      return Math.sqrt(dx * dx + dy * dy) < 2 * radius;
    });

    if (!isOverlapping) {
      canvasState.push({ id: randomUUID(), x, y, selectedBy: null }); // `selectedBy`는 선택한 클라이언트 ID
    }

    attempts++;
  }
}

generateRandomCircles();

const schema = {
  type: "object",
  required: ["PORT", "CACHE_HOST", "CACHE_PORT", "DB_URL"],
  properties: {
    PORT: {
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
  root: join(__dirname, "public"),
  prefix: "/",
});

fastify.get("/reservation", async (request, reply) => {
  return reply.sendFile("reservation.html");
});

fastify.get("/liveness", async (request, reply) => {
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
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

// 실시간 서버 시간 브로드캐스트
setInterval(() => {
  const serverTime = new Date().toISOString();
  io.emit("serverTime", serverTime);
}, 1000); // 1초마다 서버 시간 전송

const messageHistory = [];
const connectedUsers = new Map();
const seatData = {}; // Room별 좌석 정보를 저장하는 객체

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

      // 같은 room의 유저들에게 상태 변경 브로드캐스트
      io.to(roomName).emit("seatSelected", {
        seatId: previouslySelectedSeat.id,
        selectedBy: null,
        updatedAt: previouslySelectedSeat.updatedAt,
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
      fastify.log.info(`Seat ${seatId} selected by ${socket.id}`);
    }

    // 같은 room의 유저들에게 상태 변경 브로드캐스트
    io.to(roomName).emit("seatSelected", {
      seatId,
      selectedBy: seat.selectedBy,
      updatedAt: seat.updatedAt,
    });
  });

  // 마우스 위치 업데이트 이벤트 처리
  socket.on("updateMousePosition", (mouseData) => {
    // 다른 클라이언트들에게 브로드캐스트
    socket.broadcast.emit("updateMousePosition", {
      id: socket.id,
      x: mouseData.x,
      y: mouseData.y,
    });
  });

  connectedUsers.set(socket.id, "Anonymous");

  if (messageHistory.length > 0) {
    socket.emit("messageHistory", messageHistory);
  }

  // 클라이언트가 초기 상태 요청 시
  socket.emit("updateCanvas", canvasState);

  // 원 다시 생성 요청 처리
  socket.on("requestNewCircles", () => {
    generateRandomCircles(); // 새로운 원 정보 생성
    io.emit("updateCanvas", canvasState); // 모든 클라이언트에 브로드캐스트
  });

  // 원 선택 요청 처리
  socket.on("selectCircle", ({ circleId }) => {
    const circle = canvasState.find((c) => c.id === circleId);

    if (!circle) {
      socket.emit("selectionFailed", { message: "Circle not found." });
      return;
    }

    // 이미 선택된 원인지 확인
    if (circle.selectedBy && circle.selectedBy !== socket.id) {
      socket.emit("selectionFailed", {
        message: "This circle is already selected.",
      });
      return;
    }

    // 선택 상태 초기화
    const previousSelected = canvasState.find(
      (c) => c.selectedBy === socket.id
    );
    if (previousSelected) {
      clearTimeout(timers.get(previousSelected.id)); // 이전 타이머 취소
      timers.delete(previousSelected.id);
      previousSelected.selectedBy = null; // 이전 선택 취소
      previousSelected.expirationTime = null;
      io.emit("updateCircle", previousSelected); // 이전 원 상태 브로드캐스트
    }

    // 새로운 원 선택
    if (circle.selectedBy === socket.id) {
      clearTimeout(timers.get(circle.id)); // 기존 타이머 취소
      timers.delete(circle.id);
      circle.selectedBy = null;
      circle.expirationTime = null;
    } else {
      circle.selectedBy = socket.id;
      circle.expirationTime = Date.now() + SELECTION_TIMEOUT;

      // 만료 타이머 설정
      const timer = setTimeout(() => {
        circle.selectedBy = null;
        circle.expirationTime = null;
        io.emit("updateCircle", circle); // 상태 업데이트
        timers.delete(circle.id);
      }, SELECTION_TIMEOUT);

      timers.set(circle.id, timer);
    }

    io.emit("updateCircle", circle); // 현재 원 상태 브로드캐스트
  });

  const broadcastUserList = () => {
    const userList = Array.from(connectedUsers.values());
    io.emit("userList", { count: connectedUsers.size, users: userList });
  };
  broadcastUserList();

  // 닉네임 설정 처리
  socket.on("setNickname", (nickname) => {
    connectedUsers.set(socket.id, nickname || "Anonymous");
    broadcastUserList();
  });

  socket.on("message", (data) => {
    fastify.log.info(`Message received: ${data}`);

    // 메시지 저장 및 제한된 크기 유지
    messageHistory.push(data);
    if (messageHistory.length > 100) {
      messageHistory.shift(); // 오래된 메시지 삭제
    }

    io.emit("message", data);
  });

  socket.on("disconnect", () => {
    fastify.log.info(`Client disconnected: ${socket.id}`);
    connectedUsers.delete(socket.id);
    broadcastUserList();
    canvasState.forEach((circle) => {
      if (circle.selectedBy === socket.id) {
        circle.selectedBy = null;
      }
    });
    io.emit("updateCanvas", canvasState);
    io.emit("removeCursor", { id: socket.id });

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
