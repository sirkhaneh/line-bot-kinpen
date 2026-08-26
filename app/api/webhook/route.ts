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
  target_calories: number | null;
  target_protein_g: number | null;
}

async function getUser(userId: string): Promise<UserProfile | null> {
  const { data } = await supabase.from("users").select("*").eq("user_id", userId).maybeSingle();
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

// คำนวณ TDEE ด้วยสูตร Mifflin-St Jeor + ปรับตามเป้าหมาย
function calculateTargets(user: {
  gender: string;
  age: number;
  weight_kg: number;
  height_cm: number;
  goal: string;
}) {
  const bmr =
    user.gender === "male"
      ? 10 * user.weight_kg + 6.25 * user.height_cm - 5 * user.age + 5
      : 10 * user.weight_kg + 6.25 * user.height_cm - 5 * user.age - 161;

  // สมมติกิจกรรมระดับเบา-ปานกลาง (ยังไม่ได้เก็บข้อมูลระดับออกกำลังกายจริง)
  const tdee = bmr * 1.375;

  let targetCalories = tdee;
  let proteinPerKg = 1.4;

  if (user.goal === "ลดน้ำหนัก") {
    targetCalories = tdee - 500;
    proteinPerKg = 1.8;
  } else if (user.goal === "เพิ่มกล้าม/พลังงาน") {
    targetCalories = tdee + 300;
    proteinPerKg = 2.0;
  } else if (user.goal === "เพิ่มคุณภาพอสุจิ") {
    targetCalories = tdee;
    proteinPerKg = 1.8;
  }

  return {
    targetCalories: Math.round(targetCalories),
    targetProtein: Math.round(user.weight_kg * proteinPerKg),
  };
}

async function handleOnboarding(userId: string, user: UserProfile, text: string, replyToken: string) {
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

    const { targetCalories, targetProtein } = calculateTargets({
      gender: user.gender!,
      age: user.age!,
      weight_kg: user.weight_kg!,
      height_cm: height,
      goal: user.goal!,
    });

    await updateUser(userId, {
      height_cm: height,
      onboarding_step: "completed",
      target_calories: targetCalories,
      target_protein_g: targetProtein,
    });

    let extraNote = "";
    if (user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ") {
      extraNote =
        "\nสารสำคัญที่ควรได้ครบทุกวัน: สังกะสี ~11mg, ซีลีเนียม ~55mcg (จากอาหารทะเล ถั่ว เมล็ดฟักทอง)";
    }

    await replyMessage(
      replyToken,
      `เรียบร้อยครับ! 🎉\n\nจากข้อมูลของคุณ เป้าหมายพลังงานต่อวันอยู่ที่ประมาณ ${targetCalories} แคล โปรตีนประมาณ ${targetProtein} กรัม${extraNote}\n\n(ค่าประมาณกลางๆ ยังไม่รวมระดับกิจกรรมจริง ใช้เป็นแนวทางได้เลยครับ)\n\nลองส่งเมนูที่กินมาได้เลยครับ`
    );
    return;
  }
}

// คำนวณ "เที่ยงคืนของไทย" ให้ถูกต้อง ไม่พึ่ง timezone ของ server
function getThailandStartOfDayISO(): string {
  const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;
  const now = new Date();
  const thaiNow = new Date(now.getTime() + THAI_OFFSET_MS);
  const thaiMidnightFields = new Date(
    Date.UTC(thaiNow.getUTCFullYear(), thaiNow.getUTCMonth(), thaiNow.getUTCDate(), 0, 0, 0)
  );
  const actualUTCInstant = new Date(thaiMidnightFields.getTime() - THAI_OFFSET_MS);
  return actualUTCInstant.toISOString();
}

interface DailyTotals {
  calories: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
}

async function getTodayTotals(
  userId: string
): Promise<{ totals: DailyTotals; foodList: string }> {
  const startOfDayISO = getThailandStartOfDayISO();

  const { data, error } = await supabase
    .from("food_logs")
    .select("food_text, calories, protein_g, carb_g, fat_g")
    .eq("user_id", userId)
    .gte("created_at", startOfDayISO);

  if (error || !data || data.length === 0) {
    return { totals: { calories: 0, protein_g: 0, carb_g: 0, fat_g: 0 }, foodList: "" };
  }

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
  return { totals, foodList };
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
  previousTotals: DailyTotals,
  foodListSoFar: string
): Promise<AiResult> {
  const contextNote =
    foodListSoFar.length > 0
      ? `ก่อนหน้ามื้อนี้ วันนี้กินไปแล้ว: ${foodListSoFar} รวมพลังงานประมาณ ${previousTotals.calories} แคล โปรตีน ${previousTotals.protein_g} กรัม คาร์บ ${previousTotals.carb_g} กรัม ไขมัน ${previousTotals.fat_g} กรัม`
      : "วันนี้ยังไม่มีข้อมูลมื้อก่อนหน้า ถือว่าเป็นมื้อแรกของวัน";

  const profileNote = `ผู้ใช้เพศ${user.gender === "male" ? "ชาย" : "หญิง"} อายุ ${user.age} ปี น้ำหนัก ${user.weight_kg} กก. ส่วนสูง ${user.height_cm} ซม. เป้าหมายหลักคือ "${user.goal}"`;

  const fertilityInstruction =
    user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ"
      ? "เน้นชี้จุดที่เกี่ยวกับ zinc, selenium, omega-3, antioxidant, vitamin C/E, folate, CoQ10 ในทุกคำตอบ"
      : user.gender === "male"
      ? "ถ้าเมนูมีสารอาหารเกี่ยวกับสุขภาพสืบพันธุ์เพศชายชัดเจน พูดถึงสั้นๆ ได้ แต่ไม่ต้องเน้น"
      : "ห้ามพูดเรื่องสุขภาพสืบพันธุ์เพศชายเด็ดขาด";

  const goalInstruction =
    user.goal === "ลดน้ำหนัก"
      ? "เน้นเตือนถ้าแคล/คาร์บของมื้อนี้ค่อนข้างสูง"
      : user.goal === "เพิ่มกล้าม/พลังงาน"
      ? "เน้นเช็คว่าโปรตีนพอไหม"
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
            '{"reply": "ข้อความภาษาไทย กระชับ", "calories": ตัวเลข, "protein_g": ตัวเลข, "carb_g": ตัวเลข, "fat_g": ตัวเลข}\n\n' +
            "ตัวเลข 4 ตัว = ค่าประมาณรวมของทุกเมนูที่กล่าวถึงในข้อความนี้ (ถ้ามีหลายเมนู ให้บวกรวมเป็นตัวเลขเดียว) เป็นจำนวนเต็ม ไม่ใช่ช่วง\n\n" +
            "เมื่อประมาณปริมาณ ให้สมมติเป็นหน่วยมาตรฐาน (จาน/ชาม/แก้ว/ลูก/ฟอง/แผ่น หรือ 'ที่' ถ้าไม่แน่ใจ) และระบุหน่วยนั้นในคำตอบเสมอ\n\n" +
            "**ห้ามพูดถึงยอดสะสมรวมทั้งวันในคำตอบเด็ดขาด ห้ามบวกเลขเอง** เพราะระบบจะคำนวณและต่อท้ายให้อัตโนมัติแบบแม่นยำ ให้ 'reply' พูดแค่: ค่าพลังงาน/สารอาหารของมื้อนี้มื้อเดียว, ข้อสังเกตตามเป้าหมาย/fertility, คำแนะนำมื้อถัดไป\n\n" +
            `ข้อมูลผู้ใช้: ${profileNote}\n` +
            `คำแนะนำเรื่อง fertility: ${fertilityInstruction}\n` +
            `คำแนะนำเรื่องเป้าหมาย: ${goalInstruction}\n\n` +
            "ถ้าผู้ใช้พิมพ์เรื่องอื่นที่ไม่เกี่ยวกับอาหาร ตอบใน 'reply' แบบเพื่อนคุยสั้นๆ แล้วชวนกลับมาเรื่องอาหาร และให้ตัวเลขทั้งหมดเป็น 0\n\n" +
            "ห้ามพูดในเชิงฟันธงหรืออ้างว่าเป็นคำแนะนำทางการแพทย์ ตอบกระชับ ไม่เกิน 5-6 บรรทัด (ระบบจะต่อท้ายสรุปยอดสะสมให้เอง)\n\n" +
            `ข้อมูลวันนี้ก่อนมื้อนี้: ${contextNote}`,
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

// สร้างข้อความสรุปยอดสะสม "ด้วยโค้ด" ไม่ใช่ให้ AI พูดเอง — จุดสำคัญของการแก้บั๊กวันนี้
function buildSummaryBlock(
  mealTotals: AiResult,
  previousTotals: DailyTotals,
  targetCalories: number | null,
  targetProtein: number | null
): string {
  const newTotals = {
    calories: previousTotals.calories + mealTotals.calories,
    protein_g: previousTotals.protein_g + mealTotals.protein_g,
    carb_g: previousTotals.carb_g + mealTotals.carb_g,
    fat_g: previousTotals.fat_g + mealTotals.fat_g,
  };

  let line = `\n\n📊 ยอดสะสมวันนี้: ${newTotals.calories} แคล`;
  if (targetCalories) {
    const remaining = targetCalories - newTotals.calories;
    line +=
      remaining >= 0
        ? ` จาก ${targetCalories} แคล (เหลืออีก ${remaining})`
        : ` จาก ${targetCalories} แคล (เกินไป ${Math.abs(remaining)})`;
  }
  line += `\nโปรตีน ${newTotals.protein_g}g`;
  if (targetProtein) line += `/${targetProtein}g`;
  line += ` | คาร์บ ${newTotals.carb_g}g | ไขมัน ${newTotals.fat_g}g`;

  return line;
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

        const { totals: previousTotals, foodList } = await getTodayTotals(userId);
        const result = await analyzeFoodText(userText, user, previousTotals, foodList);

        const isFoodMessage =
          result.calories !== 0 || result.protein_g !== 0 || result.carb_g !== 0 || result.fat_g !== 0;

        const finalReply = isFoodMessage
          ? result.reply +
            buildSummaryBlock(result, previousTotals, user.target_calories, user.target_protein_g)
          : result.reply;

        await replyMessage(replyToken, finalReply);

        if (isFoodMessage) {
          await saveFoodLog(userId, userText, result);
        }
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