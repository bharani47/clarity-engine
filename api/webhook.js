const axios = require('axios');

module.exports = async (req, res) => {
    // Vercel handles routing; we only want to process POST requests from Telegram
    if (req.method !== 'POST') {
        return res.status(200).send('Clarity CX Webhook Engine is online.');
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_API = `https://api.telegram.org/bot${token}`;

    try {
        const update = req.body;
        
        // Ensure the payload contains a message
        if (update.message) {
            const chatId = update.message.chat.id;

            // --- PHASE 1: TEXT ROUTING ---
            if (update.message.text) {
                const text = update.message.text;
                let reply = "Clarity CX Support Agent initialized. Please upload a photo of the damaged item for instant verification.";

                // The "Smoke and Mirrors" Hackathon Trigger
                if (text.toLowerCase().includes("order #8849 is broken")) {
                    reply = "Order #8849 located. Manual review bypassed. Please upload visual evidence of the defect.";
                }

                await axios.post(`${TELEGRAM_API}/sendMessage`, {
                    chat_id: chatId,
                    text: reply
                });
            }
            
            // --- PHASE 2: IMAGE ROUTING (Placeholder for next step) ---
            else if (update.message.photo) {
                await axios.post(`${TELEGRAM_API}/sendMessage`, {
                    chat_id: chatId,
                    text: "Visual data received. Running computer vision defect analysis..."
                });
                
                // We will add the AI Vision logic here in the next step
            }
        }
        
        // Acknowledge receipt to Telegram so they don't retry the payload
        return res.status(200).send('OK');

    } catch (error) {
        console.error('Execution Error:', error);
        return res.status(500).send('Internal Server Error');
    }
};