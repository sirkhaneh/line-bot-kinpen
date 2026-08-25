import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET!;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

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

async function getTodaySummary(userId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("food_logs")
    .select("food_text, calories, protein_g, carb_g, fat_g")
    .eq("user_id", userId)
    .gte("created_at", startOfDay.toISOString());

  if (error || !data || data.length === 0) return null;

  const totals = data.reduce(
    (acc, row) => ({
      calories: acc.calories + (row.calories || 0),
      protein_g: acc.protein_g + (row.protein_g || 0),
      carb_g: acc.carb_g + (row.carb_g || 0),
      fat_g: acc.fat_g + (row.fat_g || 0),
    }),
    { calories: 0, protein_g: 0, carb_g: 0, fat_g: 0 }
  );

  const foodList = data.map((row) => row.food_text).join(", ");

  return { totals, foodList, mealCount: data.length };
}

async function analyzeFoodText(
  foodText: string,
  todaySummary: Awaited<ReturnType<typeof getTodaySummary>>
) {
  const contextNote = todaySummary
    ? `วันนี้ผู้ใช้กินไปแล้ว ${todaySummary.mealCount} มื้อ: ${todaySummary.foodList} รวมพลังงานประมาณ ${todaySummary.totals.calories} แคล โปรตีนประมาณ ${todaySummary.totals.protein_g} กรัม คาร์บประมาณ ${todaySummary.totals.carb_g} กรัม ไขมันประมาณ ${todaySummary.totals.fat_g} กรัม (ทั้งหมดนี้ไม่รวมมื้อล่าสุดที่กำลังจะวิเคราะห์)`
    : "วันนี้ยังไม่มีข้อมูลมื้อก่อนหน้า ถือว่าเป็นมื้อแรกของวัน";

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
            "คุณมีข้อมูลว่าวันนี้ผู้ใช้กินอะไรไปแล้วบ้าง ให้นำมาพิจารณาประกอบด้วยเสมอ\n\n" +
            "ถ้าผู้ใช้บอกชื่ออาหารหรือสิ่งที่กิน ให้ตอบตามโครงสร้างนี้ (ปรับภาษาให้เป็นธรรมชาติ ไม่ต้องเป็นหัวข้อบังคับ):\n" +
            "1. ประมาณค่าพลังงาน โปรตีน คาร์บ ไขมัน ของมื้อนี้แบบคร่าวๆ\n" +
            "2. บอกยอดสะสมรวมทั้งวัน (รวมมื้อนี้ด้วย) แบบคร่าวๆ\n" +
            "3. ถ้าเมนูนี้มีสารอาหารที่เกี่ยวข้องกับสุขภาพระบบสืบพันธุ์เพศชายและคุณภาพอสุจิ (zinc, selenium, omega-3, antioxidant, vitamin C/E, folate, CoQ10) ให้ชี้ให้เห็นแบบสั้นๆ\n" +
            "4. แนะนำมื้อต่อไปสั้นๆ โดยพิจารณาจากสิ่งที่กินไปแล้ววันนี้ด้วย ไม่ใช่แค่มื้อนี้มื้อเดียว\n\n" +
            "ถ้าผู้ใช้พิมพ์เรื่องอื่นที่ไม่เกี่ยวกับอาหาร ให้ตอบแบบเพื่อนคุยเป็นกันเองสั้นๆ แล้วชวนกลับมาเรื่องอาหารเบาๆ\n\n" +
            "ห้ามพูดในเชิงฟันธงหรืออ้างว่าเป็นคำแนะนำทางการแพทย์ ตอบเป็นภาษาไทย กระชับ ไม่เกิน 7-8 บรรทัด\n\n" +
            `ข้อมูลวันนี้: ${contextNote}`,
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

function extractNumber(text: string, keyword: string): number | null {
  const regex = new RegExp(`${keyword}[^\\d]{0,10}(\\d+)`, "i");
  const match = text.match(regex);
  return match ? parseInt(match[1]) : null;
}

async function saveFoodLog(userId: string, foodText: string, aiReply: string) {
  await supabase.from("food_logs").insert({
    user_id: userId,
    food_text: foodText,
    calories: extractNumber(aiReply, "แคล"),
    protein_g: extractNumber(aiReply, "โปรตีน"),
    carb_g: extractNumber(aiReply, "คาร์บ"),
    fat_g: extractNumber(aiReply, "ไขมัน"),
    ai_response: aiReply,
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
        const userId = event.source.userId;
        const userText = event.message.text;

        const todaySummary = await getTodaySummary(userId);
        const aiReply = await analyzeFoodText(userText, todaySummary);
        await replyMessage(event.replyToken, aiReply);
        await saveFoodLog(userId, userText, aiReply);
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