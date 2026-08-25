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

async function replyMessage(replyToken: string, text: string, quickReplyOptions?: string[]) {
  const message: Record<string, unknown> = { type: "text", text };

  if (quickReplyOptions && quickReplyOptions.length > 0) {
    message.quickReply = {
      items: quickReplyOptions.map((label) => ({
        type: "action",
        action: { type: "message", label, text: label },
      })),
    };
  }

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [message] }),
  });
}

interface UserProfile {
  user_id: string;
  gender: string | null;
  goal: string | null;
  age: number | null;
  weight_kg: number | null;
  height_cm: number | null;
  onboarding_step: string;
}

async function getUser(userId: string): Promise<UserProfile | null> {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

async function createUser(userId: string) {
  await supabase.from("users").insert({ user_id: userId, onboarding_step: "ask_gender" });
}

async function updateUser(userId: string, fields: Partial<UserProfile>) {
  await supabase.from("users").update(fields).eq("user_id", userId);
}

const MALE_GOALS = ["เพิ่มคุณภาพอสุจิ", "เพิ่มกล้าม/พลังงาน", "ลดน้ำหนัก", "สุขภาพทั่วไป"];
const FEMALE_GOALS = ["เพิ่มกล้าม/พลังงาน", "ลดน้ำหนัก", "สุขภาพทั่วไป"];

async function handleOnboarding(
  userId: string,
  user: UserProfile,
  text: string,
  replyToken: string
) {
  const t = text.trim();

  if (user.onboarding_step === "ask_gender") {
    let gender: string | null = null;
    if (t === "ชาย") gender = "male";
    else if (t === "หญิง") gender = "female";

    if (!gender) {
      await replyMessage(replyToken, "เลือกจากปุ่มด้านล่างได้เลยครับ 🙂", ["ชาย", "หญิง"]);
      return;
    }

    await updateUser(userId, { gender, onboarding_step: "ask_goal" });
    const goals = gender === "male" ? MALE_GOALS : FEMALE_GOALS;
    await replyMessage(replyToken, "เป้าหมายหลักตอนนี้คืออะไรครับ?", goals);
    return;
  }

  if (user.onboarding_step === "ask_goal") {
    const goals = user.gender === "male" ? MALE_GOALS : FEMALE_GOALS;
    if (!goals.includes(t)) {
      await replyMessage(replyToken, "เลือกจากปุ่มด้านล่างได้เลยครับ 🙂", goals);
      return;
    }

    await updateUser(userId, { goal: t, onboarding_step: "ask_age" });
    await replyMessage(replyToken, "อายุเท่าไหร่ครับ? (พิมพ์ตัวเลข เช่น 32)");
    return;
  }

  if (user.onboarding_step === "ask_age") {
    const age = parseInt(t.replace(/\D/g, ""));
    if (!age || age < 10 || age > 100) {
      await replyMessage(replyToken, "ขอเป็นตัวเลขอายุนะครับ เช่น 32");
      return;
    }
    await updateUser(userId, { age, onboarding_step: "ask_weight" });
    await replyMessage(replyToken, "น้ำหนักตอนนี้กี่กิโลครับ? (พิมพ์ตัวเลข เช่น 70)");
    return;
  }

  if (user.onboarding_step === "ask_weight") {
    const weight = parseInt(t.replace(/\D/g, ""));
    if (!weight || weight < 20 || weight > 300) {
      await replyMessage(replyToken, "ขอเป็นตัวเลขน้ำหนักนะครับ เช่น 70");
      return;
    }
    await updateUser(userId, { weight_kg: weight, onboarding_step: "ask_height" });
    await replyMessage(replyToken, "ส่วนสูงกี่เซนติเมตรครับ? (พิมพ์ตัวเลข เช่น 170)");
    return;
  }

  if (user.onboarding_step === "ask_height") {
    const height = parseInt(t.replace(/\D/g, ""));
    if (!height || height < 100 || height > 250) {
      await replyMessage(replyToken, "ขอเป็นตัวเลขส่วนสูงนะครับ เช่น 170");
      return;
    }
    await updateUser(userId, { height_cm: height, onboarding_step: "completed" });
    await replyMessage(
      replyToken,
      "เรียบร้อยครับ! 🎉 ตอนนี้กินเป็นรู้จักคุณแล้ว ลองส่งเมนูที่กินมาได้เลย เช่น พิมพ์ 'ข้าวกะเพราหมู' มาดูก่อนก็ได้ครับ"
    );
    return;
  }
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

interface AiResult {
  reply: string;
  calories: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

async function analyzeFoodText(
  foodText: string,
  user: UserProfile,
  todaySummary: Awaited<ReturnType<typeof getTodaySummary>>
): Promise<AiResult> {
  const contextNote = todaySummary
    ? `วันนี้ผู้ใช้กินไปแล้ว ${todaySummary.mealCount} มื้อ: ${todaySummary.foodList} รวมพลังงานประมาณ ${todaySummary.totals.calories} แคล โปรตีนประมาณ ${todaySummary.totals.protein_g} กรัม คาร์บประมาณ ${todaySummary.totals.carb_g} กรัม ไขมันประมาณ ${todaySummary.totals.fat_g} กรัม (ไม่รวมมื้อล่าสุด)`
    : "วันนี้ยังไม่มีข้อมูลมื้อก่อนหน้า ถือว่าเป็นมื้อแรกของวัน";

  const profileNote = `ผู้ใช้เพศ${user.gender === "male" ? "ชาย" : "หญิง"} อายุ ${user.age} ปี น้ำหนัก ${user.weight_kg} กก. ส่วนสูง ${user.height_cm} ซม. เป้าหมายหลักคือ "${user.goal}"`;

  const fertilityInstruction =
    user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ"
      ? "ผู้ใช้ตั้งเป้าหมายเรื่องเพิ่มคุณภาพอสุจิ/testosterone โดยเฉพาะ ให้เน้นชี้จุดที่เกี่ยวกับ zinc, selenium, omega-3, antioxidant, vitamin C/E, folate, CoQ10 ในทุกคำตอบ"
      : user.gender === "male"
      ? "ถ้าเมนูมีสารอาหารเกี่ยวกับสุขภาพสืบพันธุ์เพศชายชัดเจน พูดถึงสั้นๆ ได้ แต่ไม่ต้องเน้น เพราะไม่ใช่เป้าหมายหลักของผู้ใช้"
      : "ห้ามพูดเรื่องสุขภาพสืบพันธุ์เพศชายเด็ดขาด เพราะผู้ใช้เป็นเพศหญิง";

  const goalInstruction =
    user.goal === "ลดน้ำหนัก"
      ? "เน้นเตือนถ้าแคล/คาร์บของมื้อนี้ค่อนข้างสูง แนะนำทางเลือกแคลต่ำกว่าในมื้อถัดไป"
      : user.goal === "เพิ่มกล้าม/พลังงาน"
      ? "เน้นเช็คว่าโปรตีนพอไหมสำหรับเป้าหมายนี้ แนะนำเพิ่มโปรตีน/พลังงานถ้าน้อยไป"
      : "ให้คำแนะนำสมดุลทั่วไป";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "คุณคือ 'กินเป็น' ผู้ช่วย AI ด้านโภชนาการที่พูดจาเป็นกันเอง เหมือนเพื่อนที่เข้าใจอาหาร ไม่ใช่หมอหรือนักโภชนาการ\n\n" +
            "ตอบกลับเป็น JSON เท่านั้น:\n" +
            '{"reply": "ข้อความภาษาไทย กระชับ ไม่เกิน 7-8 บรรทัด", "calories": ตัวเลข, "protein_g": ตัวเลข, "carb_g": ตัวเลข, "fat_g": ตัวเลข}\n\n' +
            "ตัวเลข 4 ตัวเป็นค่าประมาณของมื้อนี้มื้อเดียว เป็นจำนวนเต็ม ไม่ใช่ช่วง\n\n" +
            `ข้อมูลผู้ใช้: ${profileNote}\n` +
            `คำแนะนำเรื่อง fertility: ${fertilityInstruction}\n` +
            `คำแนะนำเรื่องเป้าหมาย: ${goalInstruction}\n\n` +
            "ใน 'reply' ให้ครอบคลุม: ค่าพลังงาน/โปรตีน/คาร์บ/ไขมันของมื้อนี้, ยอดสะสมทั้งวัน, ข้อสังเกตตามเป้าหมาย, คำแนะนำมื้อถัดไป\n\n" +
            "ถ้าผู้ใช้พิมพ์เรื่องอื่นที่ไม่เกี่ยวกับอาหาร ตอบใน 'reply' แบบเพื่อนคุยสั้นๆ แล้วชวนกลับมาเรื่องอาหาร และให้ตัวเลขทั้งหมดเป็น 0\n\n" +
            "ห้ามพูดในเชิงฟันธงหรืออ้างว่าเป็นคำแนะนำทางการแพทย์\n\n" +
            `ข้อมูลวันนี้: ${contextNote}`,
        },
        { role: "user", content: `กินไป: ${foodText}` },
      ],
    }),
  });

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  try {
    const parsed = JSON.parse(content);
    return {
      reply: parsed.reply || "ขอโทษครับ วิเคราะห์ไม่สำเร็จ ลองส่งใหม่อีกครั้งนะครับ",
      calories: Number(parsed.calories) || 0,
      protein_g: Number(parsed.protein_g) || 0,
      carb_g: Number(parsed.carb_g) || 0,
      fat_g: Number(parsed.fat_g) || 0,
    };
  } catch {
    return {
      reply: "ขอโทษครับ วิเคราะห์ไม่สำเร็จ ลองส่งใหม่อีกครั้งนะครับ",
      calories: 0,
      protein_g: 0,
      carb_g: 0,
      fat_g: 0,
    };
  }
}

async function saveFoodLog(userId: string, foodText: string, result: AiResult) {
  await supabase.from("food_logs").insert({
    user_id: userId,
    food_text: foodText,
    calories: result.calories,
    protein_g: result.protein_g,
    carb_g: result.carb_g,
    fat_g: result.fat_g,
    ai_response: result.reply,
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
        const replyToken = event.replyToken;

        const user = await getUser(userId);

        if (!user) {
          await createUser(userId);
          await replyMessage(
            replyToken,
            "สวัสดีครับ ผมกินเป็น 🙂\nก่อนเริ่ม ขอถามข้อมูลนิดหน่อยเพื่อแนะนำได้ตรงจุดนะครับ\n\nคุณเป็นเพศอะไรครับ?",
            ["ชาย", "หญิง"]
          );
          continue;
        }

        if (user.onboarding_step !== "completed") {
          await handleOnboarding(userId, user, userText, replyToken);
          continue;
        }

        const todaySummary = await getTodaySummary(userId);
        const result = await analyzeFoodText(userText, user, todaySummary);
        await replyMessage(replyToken, result.reply);
        await saveFoodLog(userId, userText, result);
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