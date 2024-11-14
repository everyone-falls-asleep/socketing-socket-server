package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/gofiber/contrib/socketio"
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
)

// MessageObject represents a basic chat message object
type MessageObject struct {
	Data  string `json:"data"`
	From  string `json:"from"`
	Event string `json:"event"`
	To    string `json:"to"`
}

func main() {
	// Map to store connected clients
	clients := make(map[string]string)

	// Initialize a new Fiber app
	app := fiber.New()

	// Serve static files for the WebSocket client
	app.Static("/", "./public")

	// WebSocket route group
	wsGroup := app.Group("/ws", func(c *fiber.Ctx) error {
		if websocket.IsWebSocketUpgrade(c) {
			c.Locals("allowed", true)
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	})

	wsGroup.Get("/:id", socketio.New(func(kws *socketio.Websocket) {
		userId := kws.Params("id")
		clients[userId] = kws.UUID
		kws.SetAttribute("user_id", userId)

		kws.Broadcast([]byte(fmt.Sprintf("New user connected: %s", userId)), true, socketio.TextMessage)
		kws.Emit([]byte(fmt.Sprintf("Hello user: %s", userId)), socketio.TextMessage)
	}))

	// SocketIO event handling
	socketio.On(socketio.EventMessage, func(ep *socketio.EventPayload) {
		message := MessageObject{}
		err := json.Unmarshal(ep.Data, &message)
		if err != nil {
			fmt.Println("Error unmarshaling message:", err)
			return
		}

		fmt.Printf("Message event - From: %s, To: %s, Data: %s\n", message.From, message.To, message.Data)

		if message.Event != "" {
			ep.Kws.Fire(message.Event, []byte(message.Data))
		}

		err = ep.Kws.EmitTo(clients[message.To], ep.Data, socketio.TextMessage)
		if err != nil {
			fmt.Println("Error emitting to user:", err)
		}
	})

	// Start the server
	log.Fatal(app.Listen(":3000"))
}
