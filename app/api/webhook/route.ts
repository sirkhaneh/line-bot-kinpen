import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;

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
        await replyMessage(event.replyToken, "กินเป็นได้รับข้อความแล้ว");
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