const axios = require('axios');
const { MongoClient } = require('mongodb');
const { waitUntil } = require('@vercel/functions');

// --- DATABASE CONNECTION CACHING ---
let cachedClient = null;
async function getDbClient(env) {
    if (cachedClient) return cachedClient;
    const client = new MongoClient(env.MONGODB_URI);
    await client.connect();
    cachedClient = client;
    return client;
}

// --- THE 6-API INDESTRUCTIBLE VISION CASCADE ---
async function analyzeImageWithFallback(base64Image, sessionData, env) {
    const prompt = `You are Clarity CX Autonomous Claim Verifier. The customer claims the following issue: "${sessionData.reason}". Analyze the image to verify if it matches their claim. State ITEM, DEFECT, and SEVERITY (Minor/Moderate/Severe) in 3 short lines.`;
    
    const imagePayload = { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } };
    const mistralImagePayload = { type: "image_url", image_url: `data:image/jpeg;base64,${base64Image}` };

    if (env.GROQ_API_KEY) {
        try {
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.2-90b-vision-preview",
                messages: [{ role: "user", content: [{ type: "text", text: prompt }, imagePayload] }]
            }, { headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}` }, timeout: 8000 });
            return res.data.choices[0].message.content;
        } catch (e) { console.error("Groq Failed, switching..."); }
    }

    if (env.MISRAL_API_KEY) { 
        try {
            const res = await axios.post("https://api.mistral.ai/v1/chat/completions", {
                model: "pixtral-12b-2409",
                messages: [{ role: "user", content: [{ type: "text", text: prompt }, mistralImagePayload] }]
            }, { headers: { "Authorization": `Bearer ${env.MISRAL_API_KEY}` }, timeout: 8000 });
            return res.data.choices[0].message.content;
        } catch (e) { console.error("Mistral Failed, switching..."); }
    }

    if (env.OPENROUTER_API_KEY) {
        try {
            const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
                model: "meta-llama/llama-3.2-11b-vision-instruct:free",
                messages: [{ role: "user", content: [{ type: "text", text: prompt }, imagePayload] }]
            }, { headers: { "Authorization": `Bearer ${env.OPENROUTER_API_KEY}` }, timeout: 8000 });
            return res.data.choices[0].message.content;
        } catch (e) { console.error("OpenRouter Failed, switching..."); }
    }

    if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_ACCOUNT_ID) {
        try {
            const res = await axios.post(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`, {
                model: "@cf/meta/llama-3.2-11b-vision-instruct",
                messages: [{ role: "user", content: [{ type: "text", text: prompt }, imagePayload] }]
            }, { headers: { "Authorization": `Bearer ${env.CLOUDFLARE_API_KEY}` }, timeout: 8000 });
            return res.data.choices[0].message.content;
        } catch (e) { console.error("Cloudflare Failed, switching..."); }
    }

    if (env.GEMINI_API_KEY) {
        try {
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
                contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64Image } }] }]
            }, { timeout: 8000 });
            return res.data.candidates[0].content.parts[0].text;
        } catch (e) { console.error("Gemini 3.7 Overloaded, executing failover to 1.5..."); }
    }

    if (env.GEMINI_API_KEY) {
        try {
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
                contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64Image } }] }]
            }, { timeout: 8000 });
            return res.data.candidates[0].content.parts[0].text;
        } catch (e) { console.error("Gemini 1.5 Failed, executing final failover..."); }
    }

    return "ITEM: Image Received\nDEFECT: System overload. Queued for human verification.\nSEVERITY: Borderline";
}

// --- BACKGROUND PROCESSING (Triggered by waitUntil) ---
async function processClaimInBackground(update, sessionData, env) {
    const token = env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_API = `https://api.telegram.org/bot${token}`;
    const chatId = update.message.chat.id;

    try {
        const photos = update.message.photo;
        const fileId = photos[photos.length - 1].file_id;
        const fileRes = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const imageUrl = `https://api.telegram.org/file/bot${token}/${fileRes.data.result.file_path}`;

        const imgBuffer = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        
        // --- 🚨 HACKATHON NUKE: Cryptographic Fraud Prevention ---
        const crypto = require('crypto');
        const imageHash = crypto.createHash('sha256').update(imgBuffer.data).digest('hex');
        
        const client = await getDbClient(env);
        const db = client.db('claritycx');

        // Check if this exact image hash already exists in the database
        const existingClaim = await db.collection('live_claims').findOne({ imageHash: imageHash });
        
        if (existingClaim) {
            await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: chatId,
                text: `🚨 *SECURITY ALERT: DUPLICATE ASSET DETECTED*\n━━━━━━━━━━━━━━━━━━━━\n⚠️ *Fraud Prevention Triggered*\n\nOur hash-matching engine detected that this exact image file was already submitted under Claim ID: \`${existingClaim.id}\`.\n\nYour session has been locked and flagged for manual security review.\n━━━━━━━━━━━━━━━━━━━━\n_Clarity CX Security Engine_`,
                parse_mode: 'Markdown'
            });
            return; // KILLS THE PIPELINE. Does not waste AI inference costs.
        }
        // ---------------------------------------------------------

        const base64Image = Buffer.from(imgBuffer.data).toString('base64');
        const defectAnalysis = await analyzeImageWithFallback(base64Image, sessionData, env);
        const claimId = `CLM-${Math.floor(100000 + Math.random() * 900000)}`;
        
        const isSevere = defectAnalysis.toLowerCase().includes('severe');
        const statusLabel = isSevere ? "Auto-Approved" : "Manual Review";
        const severityLabel = isSevere ? "Severe" : "Moderate/Borderline";

        // Write Final Data to MongoDB (NOW SAVING THE HASH)
        await db.collection('live_claims').insertOne({
            id: claimId,
            email: sessionData.email,
            orderId: sessionData.orderId,
            userReason: sessionData.reason,
            originalLanguage: sessionData.originalLanguage || null,
            item: "Image Processed", 
            defect: defectAnalysis,
            severity: severityLabel,
            status: statusLabel,
            imageHash: imageHash,
            time: new Date().toISOString()
        });

        // HITL DYNAMIC TELEGRAM RECEIPT
        let responseText = "";
        if (isSevere) {
            responseText = `✅ *WARRANTY CLAIM VERIFIED*\n━━━━━━━━━━━━━━━━━━━━\n🆔 *Claim ID:* \`${claimId}\`\n📧 *Email:* \`${sessionData.email}\`\n📦 *Order ID:* \`${sessionData.orderId}\`\n📋 *Status:* \`AUTO-APPROVED\`\n\n🔍 *Vision Verification:*\n${defectAnalysis}\n━━━━━━━━━━━━━━━━━━━━\n_Clarity CX Autonomous Engine_`;
        } else {
            responseText = `⚠️ *HUMAN-IN-THE-LOOP TRIGGERED*\n━━━━━━━━━━━━━━━━━━━━\n🆔 *Claim ID:* \`${claimId}\`\n📋 *Status:* \`ESCALATED TO ADJUSTER\`\n\n🔍 *AI Vision Assessment:*\n${defectAnalysis}\n\n*System Note:* The AI determined this damage is borderline. Your claim has been safely paused and routed to a human adjuster for manual review on the Command Center.\n━━━━━━━━━━━━━━━━━━━━\n_Clarity CX Routing Engine_`;
        }

        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: responseText,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error("Background Processing Error:", err);
    }
}

// --- MAIN WEBHOOK HANDLER (4-Step State Machine) ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('Clarity CX Webhook Engine is online.');

    const update = req.body;
    if (!update.message) return res.status(200).send('OK');

    const chatId = update.message.chat.id;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_API = `https://api.telegram.org/bot${token}`;

    try {
        const client = await getDbClient(process.env);
        const db = client.db('claritycx');
        const sessions = db.collection('telegram_sessions');
        
        let session = await sessions.findOne({ chatId });
        const userText = update.message.text ? update.message.text.trim() : "";

        // 1. INITIALIZE CLAIM / RESET
        if (userText === '/start') {
            await sessions.updateOne({ chatId }, { $set: { step: 'AWAITING_EMAIL' } }, { upsert: true });
            await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: chatId,
                text: `🏢 *Welcome to Clarity CX Support*\n\nTo initiate an autonomous warranty claim, please reply with your registered **Email Address**.`,
                parse_mode: 'Markdown'
            });
            return res.status(200).send('OK');
        }

        if (!session) {
            await sessions.updateOne({ chatId }, { $set: { step: 'AWAITING_EMAIL' } }, { upsert: true });
            await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: chatId, text: `🏢 *Clarity CX Support*\n\nPlease provide your registered **Email Address** to begin your claim.`, parse_mode: 'Markdown'
            });
            return res.status(200).send('OK');
        }

        // 2. STEP ONE: EMAIL VALIDATION
        if (session.step === 'AWAITING_EMAIL') {
            if (!userText || !userText.includes('@')) {
                await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `⚠️ Please enter a valid email address.` });
                return res.status(200).send('OK');
            }
            await sessions.updateOne({ chatId }, { $set: { step: 'AWAITING_ORDER_ID', email: userText } });
            await axios.post(`${TELEGRAM_API}/sendMessage`, { 
                chat_id: chatId, text: `✅ Email linked: \`${userText}\`\n\nNext, please reply with your **Order ID** (e.g., ORD-99210).`, parse_mode: 'Markdown' 
            });
        } 
        
        // 3. STEP TWO: ORDER ID VALIDATION (Enterprise CRM Mock)
        else if (session.step === 'AWAITING_ORDER_ID') {
            if (!userText) return res.status(200).send('OK');
            
            const validOrders = [
                "ORD-99210", "ORD-24100", "ORD-11111", "ORD-22222", "ORD-33333", 
                "ORD-44444", "ORD-55555", "ORD-66666", "ORD-77777", "ORD-88888"
            ];

            const normalizedInput = userText.trim().toUpperCase();

            if (!validOrders.includes(normalizedInput)) {
                await axios.post(`${TELEGRAM_API}/sendMessage`, { 
                    chat_id: chatId, 
                    text: `⚠️ *CRM Verification Failed*\n\nThe ID \`${userText}\` does not exist in our purchase records. Please verify your invoice and try again.`, 
                    parse_mode: 'Markdown' 
                });
                return res.status(200).send('OK'); 
            }
            
            await sessions.updateOne({ chatId }, { $set: { step: 'AWAITING_REASON', orderId: normalizedInput } });
            await axios.post(`${TELEGRAM_API}/sendMessage`, { 
                chat_id: chatId, 
                text: `✅ Order ID verified: \`${normalizedInput}\`\n\n💬 **What happened to the product?**\n(Please describe the damage or issue briefly).`, 
                parse_mode: 'Markdown' 
            });
        }

        // 4. STEP THREE: REASON FOR DAMAGE (Translation Cascade)
        else if (session.step === 'AWAITING_REASON') {
            if (!userText) return res.status(200).send('OK');
            
            let finalReason = userText;
            let translationNotice = "";
            let translatedText = "";

            const systemPrompt = "You are an enterprise translation engine. Translate the user text to clear English. If it is already in English, return it exactly as is. Return ONLY the English text, no extra words, no quotes.";

            try {
                // Try 1: Groq
                if (process.env.GROQ_API_KEY && !translatedText) {
                    try {
                        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                            model: "llama-3.1-8b-instant", 
                            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }]
                        }, { headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 4000 });
                        translatedText = res.data.choices[0].message.content.trim();
                    } catch (e) { console.error("Groq Translation Failed, switching to OpenRouter..."); }
                }

                // Try 2: OpenRouter
                if (process.env.OPENROUTER_API_KEY && !translatedText) {
                    try {
                        const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
                            model: "meta-llama/llama-3.1-8b-instruct:free",
                            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }]
                        }, { headers: { "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}` }, timeout: 4000 });
                        translatedText = res.data.choices[0].message.content.trim();
                    } catch (e) { console.error("OpenRouter Translation Failed, switching to Mistral..."); }
                }

                // Try 3: Mistral
                if (process.env.MISRAL_API_KEY && !translatedText) {
                    try {
                        const res = await axios.post("https://api.mistral.ai/v1/chat/completions", {
                            model: "open-mistral-nemo",
                            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }]
                        }, { headers: { "Authorization": `Bearer ${process.env.MISRAL_API_KEY}` }, timeout: 4000 });
                        translatedText = res.data.choices[0].message.content.trim();
                    } catch (e) { console.error("Mistral Translation Failed."); }
                }

                if (translatedText && translatedText.toLowerCase() !== userText.toLowerCase()) {
                    finalReason = translatedText;
                    translationNotice = `\n*(Auto-translated to: "${finalReason}")*`;
                }
            } catch (globalError) {
                console.error("All Translation APIs failed.", globalError.message);
            }

            await sessions.updateOne({ chatId }, { $set: { step: 'AWAITING_PHOTO', reason: finalReason, originalLanguage: userText } });
            
            await axios.post(`${TELEGRAM_API}/sendMessage`, { 
                chat_id: chatId, text: `✅ Reason recorded.${translationNotice}\n\n📸 Finally, please upload a **clear photo** showing the damage so our Vision AI can verify your claim.`, parse_mode: 'Markdown' 
            });
        }
        
        // 5. STEP FOUR: PHOTO CAPTURE & AI EXECUTION
        else if (session.step === 'AWAITING_PHOTO') {
            if (!update.message.photo) {
                await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: `⚠️ Please upload a photo of the defect to proceed.` });
                return res.status(200).send('OK');
            }

            await axios.post(`${TELEGRAM_API}/sendMessage`, {
                chat_id: chatId, text: `⚡ *Assets received.* Cross-referencing your description with visual evidence... (This may take up to 20 seconds)`, parse_mode: 'Markdown'
            });

            waitUntil(processClaimInBackground(update, session, process.env));
            
            await sessions.deleteOne({ chatId });
        }

        return res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook Error:', error);
        return res.status(500).send('Error');
    }
};