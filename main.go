package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/gofiber/contrib/socketio"
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
)

type MessageObject struct {
	Data  string `json:"data"`
	From  string `json:"from"`
	Event string `json:"event"`
	To    string `json:"to"`
}

func main() {

	// Map to store connected clients
	clients := make(map[string]string)

	// Start a new Fiber application
	app := fiber.New()

	// Serve the HTML page at the root
	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendFile("./index.html")
	})

	// WebSocket route group with middleware
	wsGroup := app.Group("/ws")

	// Apply middleware only to WebSocket routes
	wsGroup.Use(func(c *fiber.Ctx) error {
		if websocket.IsWebSocketUpgrade(c) {
			c.Locals("allowed", true)
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	})

	// Socket.io event handlers
	socketio.On(socketio.EventConnect, func(ep *socketio.EventPayload) {
		fmt.Printf("Connected: %s\n", ep.Kws.GetStringAttribute("user_id"))
	})

	socketio.On(socketio.EventMessage, func(ep *socketio.EventPayload) {
		fmt.Printf("Message from %s: %s\n", ep.Kws.GetStringAttribute("user_id"), string(ep.Data))

		var message MessageObject
		err := json.Unmarshal(ep.Data, &message)
		if err != nil {
			fmt.Println("Error unmarshaling message:", err)
			return
		}

		// Echo the message back to the client
		ep.Kws.Emit(ep.Data, socketio.TextMessage)
	})

	socketio.On(socketio.EventDisconnect, func(ep *socketio.EventPayload) {
		delete(clients, ep.Kws.GetStringAttribute("user_id"))
		fmt.Printf("Disconnected: %s\n", ep.Kws.GetStringAttribute("user_id"))
	})

	// WebSocket route
	wsGroup.Get("/:id", socketio.New(func(kws *socketio.Websocket) {
		userId := kws.Params("id")
		clients[userId] = kws.UUID
		kws.SetAttribute("user_id", userId)

		// Send a welcome message
		welcomeMsg := fmt.Sprintf("Hello user: %s with UUID: %s", userId, kws.UUID)
		kws.Emit([]byte(welcomeMsg), socketio.TextMessage)
	}))

	log.Fatal(app.Listen(":3000"))
}
