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

io.on("connection", (socket) => {
  fastify.log.info(`New client connected: ${socket.id}`);

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
