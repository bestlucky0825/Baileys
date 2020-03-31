# Baileys
 Reverse Engineered WhatsApp Web API in Node.js. Baileys does not require Selenium or any other browser to be interface with WhatsApp Web, it does so directly using WebSockets.
 
 Thank you to [Sigalor](https://github.com/sigalor/whatsapp-web-reveng) for writing the guide reverse engineering WhatsApp Web and to the go reimplementation written by [Rhymen](https://github.com/Rhymen/go-whatsapp/tree/484cfe758705761d76724e01839d6fc473dc10c4)

Baileys is super easy to use:
1. Import using 
    ``` javascript 
        const WhatsAppWeb = require('Baileys') 
    ```
2. Create an instance of Baileys & connect using 
    ``` javascript
        let client = new WhatsAppWeb() 
        client.connect()
    ``` 
    If the connection is successful, you will see a QR code printed on your terminal screen, scan it with WhatsApp on your phone and you'll be logged in!
3. Implement the following event handlers in your code:
    1. ``` javascript 
        client.handlers.onConnected = () => { /* when you're successfully authenticated with the WhatsApp Web servers */ } 
        ```
    2. ``` javascript 
        client.handlers.onUnreadMessage = (message) => { /* called when you have a pending unread message or recieve a new message */ } 
        ```
    3. ``` javascript 
        client.handlers.onError = (error) => { /* called when there was an error */ } 
        ```
    4. ``` javascript 
        client.handlers.onDisconnect = () => { /* called when internet gets disconnected */ } 
        ```
4. Send a text message using 
    ``` javascript 
    client.sendTextMessage(id, txtMessage) 
    ``` 
    The id is the phone number of the person the message is being sent to, it must be in the format '[country code][phone number]@s.whatsapp.net', for example '+19999999999@s.whatsapp.net'
5. Send a read reciept using 
    ``` javascript 
        client.sendReadReceipt(id, messageID) 
    ```
    The id is in the same format as above. The message ID is the unique identifier of the message that you are marking as read
6. Tell someone what your status is right now by using 
    ``` javascript
        client.updatePresence(id, presence) 
    ```
    Presence can be one of the following:
    ``` javascript
        static Presence = {
            available: "available", // "online"
            unavailable: "unavailable", // offline
            composing: "composing", // "typing..."
            recording: "recording", // "recording..."
            paused: "paused" // I have no clue
        }
    ```

Check out test.js to see example usage of all these.

# Note
 I am in no way affiliated with WhatsApp. This was written for educational purposes. Use at your own discretion.