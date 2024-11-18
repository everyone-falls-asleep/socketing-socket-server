import Fastify from "fastify";
import { Server } from "socket.io";
import fastifyEnv from "@fastify/env";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const canvasWidth = 400;
const canvasHeight = 400;
const radius = 20;
const canvasState = []; // 캔버스 상태를 저장할 배열

// 랜덤 원 생성 함수
function generateRandomCircles() {
  canvasState.length = 0; // 기존 상태 초기화
  let attempts = 0;

  while (canvasState.length < 4 && attempts < 1000) {
    const x = Math.random() * (canvasWidth - 2 * radius) + radius;
    const y = Math.random() * (canvasHeight - 2 * radius) + radius;

    // 원이 겹치지 않게 생성
    const isOverlapping = canvasState.some((circle) => {
      const dx = circle.x - x;
      const dy = circle.y - y;
      return Math.sqrt(dx * dx + dy * dy) < 2 * radius;
    });

    if (!isOverlapping) {
      canvasState.push({ x, y, selectedBy: null }); // `selectedBy`는 선택한 클라이언트 ID
    }

    attempts++;
  }
}

generateRandomCircles();

const schema = {
  type: "object",
  required: ["PORT"],
  properties: {
    PORT: {
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

await fastify.register(fastifyStatic, {
  root: join(__dirname, "public"),
  prefix: "/",
});

fastify.get("/reservation", async (request, reply) => {
  return reply.sendFile("reservation.html");
});

const io = new Server(fastify.server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

const messageHistory = [];
const connectedUsers = new Map();

io.on("connection", (socket) => {
  fastify.log.info(`New client connected: ${socket.id}`);

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
  socket.on("selectCircle", ({ circleIndex }) => {
    const circle = canvasState[circleIndex];

    // 이미 다른 사람이 선택한 원인지 확인
    if (!circle || (circle.selectedBy && circle.selectedBy !== socket.id)) {
      socket.emit("selectionFailed", {
        message: "This circle is already selected.",
      });
      return;
    }

    // 원 선택 상태 업데이트
    canvasState.forEach((c, index) => {
      if (index === circleIndex) {
        c.selectedBy = c.selectedBy === socket.id ? null : socket.id; // 선택/해제
      } else if (c.selectedBy === socket.id) {
        c.selectedBy = null; // 한 번에 하나만 선택 가능
      }
    });

    io.emit("updateCanvas", canvasState); // 모든 클라이언트에 업데이트 브로드캐스트
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
