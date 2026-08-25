import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

function validateSignature(body: string, signature: string) {
  const hash = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

async function analyzeFoodText(foodText: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "คุณคือ 'กินเป็น' ผู้ช่วย AI ด้านโภชนาการที่พูดจาเป็นกันเอง เหมือนเพื่อนที่เข้าใจอาหาร ไม่ใช่หมอหรือนักโภชนาการ\n\n" +
            "เมื่อผู้ใช้บอกชื่ออาหารที่กิน ให้ตอบตามโครงสร้างนี้ (ปรับภาษาให้เป็นธรรมชาติ ไม่ต้องเป็นหัวข้อบังคับ):\n" +
            "1. ประมาณค่าพลังงาน โปรตีน คาร์บ ไขมัน แบบคร่าวๆ (ใช้คำว่า 'ประมาณ' เสมอ)\n" +
            "2. ถ้าเมนูนี้มีสารอาหารที่เกี่ยวข้องกับสุขภาพระบบสืบพันธุ์เพศชายและคุณภาพอสุจิ (เช่น zinc, selenium, omega-3, antioxidant, vitamin C, vitamin E, folate, CoQ10) ให้ชี้ให้เห็นว่าเมนูนี้ช่วยหรือไม่ช่วยตรงนี้ยังไง แบบสั้นๆ เป็นกันเอง ไม่ต้องใช้ศัพท์วิชาการเยอะ\n" +
            "3. แนะนำมื้อต่อไปสั้นๆ ว่าควรเพิ่มอะไรเพื่อให้สมดุลทั้งเรื่องพลังงานและเรื่องสุขภาพสืบพันธุ์\n\n" +
            "ห้ามพูดในเชิงฟันธงหรืออ้างว่าเป็นคำแนะนำทางการแพทย์ ถ้าผู้ใช้ถามเรื่องปัญหาสุขภาพเฉพาะทาง ให้แนะนำให้ปรึกษาแพทย์ด้วย ตอบเป็นภาษาไทย กระชับ ไม่เกิน 6-7 บรรทัด",
        },
        {
          role: "user",
          content: `กินไป: ${foodText}`,
        },
      ],
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "ขอโทษครับ วิเคราะห์ไม่สำเร็จ ลองส่งใหม่อีกครั้งนะครับ";
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature") || "";

    if (!validateSignature(rawBody, signature)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const json = JSON.parse(rawBody);
    const events = json.events || [];

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userText = event.message.text;
        const aiReply = await analyzeFoodText(userText);
        await replyMessage(event.replyToken, aiReply);
      }
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "something went wrong" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "webhook is running" });
}