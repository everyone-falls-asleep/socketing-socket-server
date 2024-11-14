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

	// HTTP route
	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("Hello, World 👋!")
	})

	// WebSocket route group
	wsGroup := app.Group("/ws", func(c *fiber.Ctx) error {
		// Check if it's a WebSocket upgrade request
		if websocket.IsWebSocketUpgrade(c) {
			c.Locals("allowed", true)
			return c.Next()
		}
		return fiber.ErrUpgradeRequired
	})

	// Define WebSocket route within the group
	wsGroup.Get("/:id", socketio.New(func(kws *socketio.Websocket) {
		// Retrieve user ID from the URL
		userId := kws.Params("id")

		// Add the connection to the list of connected clients
		clients[userId] = kws.UUID

		// Store the user ID in the WebSocket session
		kws.SetAttribute("user_id", userId)

		// Broadcast a message to all connected users
		kws.Broadcast([]byte(fmt.Sprintf("New user connected: %s with UUID: %s", userId, kws.UUID)), true, socketio.TextMessage)

		// Send a welcome message to the current user
		kws.Emit([]byte(fmt.Sprintf("Hello user: %s with UUID: %s", userId, kws.UUID)), socketio.TextMessage)
	}))

	// SocketIO event handling
	socketio.On(socketio.EventConnect, func(ep *socketio.EventPayload) {
		fmt.Printf("Connection event - User: %s\n", ep.Kws.GetStringAttribute("user_id"))
	})

	socketio.On("CUSTOM_EVENT", func(ep *socketio.EventPayload) {
		fmt.Printf("Custom event - User: %s\n", ep.Kws.GetStringAttribute("user_id"))
	})

	socketio.On(socketio.EventMessage, func(ep *socketio.EventPayload) {
		message := MessageObject{}
		err := json.Unmarshal(ep.Data, &message)
		if err != nil {
			fmt.Println("Error unmarshaling message:", err)
			return
		}

		fmt.Printf("Message event - From: %s, To: %s, Data: %s\n", message.From, message.To, message.Data)

		// Emit a custom event if specified
		if message.Event != "" {
			ep.Kws.Fire(message.Event, []byte(message.Data))
		}

		// Emit the message directly to the specified user
		err = ep.Kws.EmitTo(clients[message.To], ep.Data, socketio.TextMessage)
		if err != nil {
			fmt.Println("Error emitting to user:", err)
		}
	})

	socketio.On(socketio.EventDisconnect, func(ep *socketio.EventPayload) {
		userId := ep.Kws.GetStringAttribute("user_id")
		delete(clients, userId)
		fmt.Printf("Disconnection event - User: %s\n", userId)
	})

	socketio.On(socketio.EventClose, func(ep *socketio.EventPayload) {
		userId := ep.Kws.GetStringAttribute("user_id")
		delete(clients, userId)
		fmt.Printf("Close event - User: %s\n", userId)
	})

	// Start the server
	log.Fatal(app.Listen(":3000"))
}
