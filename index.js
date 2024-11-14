import Fastify from "fastify";
import { Server } from "socket.io";
import fastifyEnv from "@fastify/env";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const io = new Server(fastify.server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket"],
});

const messageHistory = [];

io.on("connection", (socket) => {
  fastify.log.info(`New client connected: ${socket.id}`);

  if (messageHistory.length > 0) {
    socket.emit("messageHistory", messageHistory);
  }

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
