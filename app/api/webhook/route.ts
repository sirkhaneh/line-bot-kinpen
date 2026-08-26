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

// ป้องกัน LINE webhook ส่งซ้ำ — ใช้ unique constraint ของ DB เช็คแบบ atomic
async function isDuplicateMessage(messageId: string): Promise<boolean> {
  const { error } = await supabase.from("processed_messages").insert({ message_id: messageId });
  if (error) {
    if (error.code === "23505") return true; // unique_violation = เคยประมวลผลไปแล้ว
    console.error("dedup check error:", error);
    return false; // error อื่นที่ไม่ใช่ duplicate ให้ประมวลผลต่อไป ดีกว่าทำข้อความหาย
  }
  return false;
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

const FERTILITY_TARGETS = {
  zinc_mg: 11,
  selenium_mcg: 55,
  omega3_mg: 300,
  folate_mcg: 400,
  vitamin_c_mg: 90,
};

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
      extraNote = `\nสารสำคัญที่ควรได้ครบทุกวัน: สังกะสี ~${FERTILITY_TARGETS.zinc_mg}mg, ซีลีเนียม ~${FERTILITY_TARGETS.selenium_mcg}mcg, โฟเลต ~${FERTILITY_TARGETS.folate_mcg}mcg, วิตามินซี ~${FERTILITY_TARGETS.vitamin_c_mg}mg, โอเมก้า-3 ~${FERTILITY_TARGETS.omega3_mg}mg`;
    }

    await replyMessage(
      replyToken,
      `เรียบร้อยครับ! 🎉\n\nจากข้อมูลของคุณ เป้าหมายพลังงานต่อวันอยู่ที่ประมาณ ${targetCalories} แคล โปรตีนประมาณ ${targetProtein} กรัม${extraNote}\n\n(ค่าประมาณกลางๆ ยังไม่รวมระดับกิจกรรมจริง ใช้เป็นแนวทางได้เลยครับ)\n\nลองส่งเมนูที่กินมาได้เลยครับ (พิมพ์ 'สรุปรายอาทิตย์' หรือ 'สรุปเดือนนี้' เพื่อดูภาพรวมย้อนหลังได้ด้วยนะ)`
    );
    return;
  }
}

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
  zinc_mg: number;
  selenium_mcg: number;
  omega3_mg: number;
  folate_mcg: number;
  vitamin_c_mg: number;
}

const EMPTY_TOTALS: DailyTotals = {
  calories: 0,
  protein_g: 0,
  carb_g: 0,
  fat_g: 0,
  zinc_mg: 0,
  selenium_mcg: 0,
  omega3_mg: 0,
  folate_mcg: 0,
  vitamin_c_mg: 0,
};

async function getTodayTotals(
  userId: string
): Promise<{ totals: DailyTotals; foodList: string }> {
  const startOfDayISO = getThailandStartOfDayISO();

  const { data, error } = await supabase
    .from("food_logs")
    .select(
      "food_text, calories, protein_g, carb_g, fat_g, zinc_mg, selenium_mcg, omega3_mg, folate_mcg, vitamin_c_mg"
    )
    .eq("user_id", userId)
    .gte("created_at", startOfDayISO);

  if (error || !data || data.length === 0) {
    return { totals: { ...EMPTY_TOTALS }, foodList: "" };
  }

  const totals = data.reduce(
    (acc, row) => ({
      calories: acc.calories + (row.calories || 0),
      protein_g: acc.protein_g + (row.protein_g || 0),
      carb_g: acc.carb_g + (row.carb_g || 0),
      fat_g: acc.fat_g + (row.fat_g || 0),
      zinc_mg: acc.zinc_mg + (row.zinc_mg || 0),
      selenium_mcg: acc.selenium_mcg + (row.selenium_mcg || 0),
      omega3_mg: acc.omega3_mg + (row.omega3_mg || 0),
      folate_mcg: acc.folate_mcg + (row.folate_mcg || 0),
      vitamin_c_mg: acc.vitamin_c_mg + (row.vitamin_c_mg || 0),
    }),
    { ...EMPTY_TOTALS }
  );

  const foodList = data.map((row) => row.food_text).join(", ");
  return { totals, foodList };
}

// ตรวจจับคำสั่งขอสรุปย้อนหลัง
function detectSummaryRequest(text: string): "week" | "month" | null {
  const t = text.trim();
  if (!/สรุป/.test(t)) return null;
  if (/เดือน|30\s*วัน/.test(t)) return "month";
  if (/อาทิตย์|สัปดาห์|7\s*วัน/.test(t)) return "week";
  return null;
}

async function getPeriodStats(
  userId: string,
  days: number
): Promise<{ totals: DailyTotals; daysLogged: number } | null> {
  const cutoffISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("food_logs")
    .select(
      "created_at, calories, protein_g, carb_g, fat_g, zinc_mg, selenium_mcg, omega3_mg, folate_mcg, vitamin_c_mg"
    )
    .eq("user_id", userId)
    .gte("created_at", cutoffISO);

  if (error || !data || data.length === 0) return null;

  const totals = data.reduce(
    (acc, row) => ({
      calories: acc.calories + (row.calories || 0),
      protein_g: acc.protein_g + (row.protein_g || 0),
      carb_g: acc.carb_g + (row.carb_g || 0),
      fat_g: acc.fat_g + (row.fat_g || 0),
      zinc_mg: acc.zinc_mg + (row.zinc_mg || 0),
      selenium_mcg: acc.selenium_mcg + (row.selenium_mcg || 0),
      omega3_mg: acc.omega3_mg + (row.omega3_mg || 0),
      folate_mcg: acc.folate_mcg + (row.folate_mcg || 0),
      vitamin_c_mg: acc.vitamin_c_mg + (row.vitamin_c_mg || 0),
    }),
    { ...EMPTY_TOTALS }
  );

  const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;
  const loggedDates = new Set(
    data.map((row) => {
      const d = new Date(new Date(row.created_at).getTime() + THAI_OFFSET_MS);
      return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    })
  );

  return { totals, daysLogged: loggedDates.size };
}

function buildPeriodSummary(
  periodLabel: string,
  days: number,
  stats: { totals: DailyTotals; daysLogged: number } | null,
  targetCalories: number | null,
  targetProtein: number | null,
  showFertilityMicros: boolean
): string {
  if (!stats) {
    return `ยังไม่มีข้อมูลใน${periodLabel}เลยครับ ลองบันทึกอาหารสักพักแล้วค่อยกลับมาดูสรุปนะครับ 🙂`;
  }

  const pct = (value: number, target: number) => Math.round((value / target) * 100);

  const avg = {
    calories: Math.round(stats.totals.calories / days),
    protein_g: Math.round(stats.totals.protein_g / days),
    carb_g: Math.round(stats.totals.carb_g / days),
    fat_g: Math.round(stats.totals.fat_g / days),
    zinc_mg: Math.round(stats.totals.zinc_mg / days),
    selenium_mcg: Math.round(stats.totals.selenium_mcg / days),
    omega3_mg: Math.round(stats.totals.omega3_mg / days),
    folate_mcg: Math.round(stats.totals.folate_mcg / days),
    vitamin_c_mg: Math.round(stats.totals.vitamin_c_mg / days),
  };

  let msg = `📅 สรุป${periodLabel} (บันทึกไป ${stats.daysLogged}/${days} วัน)\n\nเฉลี่ยต่อวัน:\n`;
  msg += `แคล: ${avg.calories}`;
  if (targetCalories) msg += `/${targetCalories} (${pct(avg.calories, targetCalories)}%)`;
  msg += `\nโปรตีน: ${avg.protein_g}g`;
  if (targetProtein) msg += `/${targetProtein}g (${pct(avg.protein_g, targetProtein)}%)`;
  msg += `\nคาร์บ: ${avg.carb_g}g\nไขมัน: ${avg.fat_g}g`;

  if (showFertilityMicros) {
    msg += `\n\n🎯 เฉลี่ยสารอาหารเพื่ออสุจิ/วัน:\n`;
    msg += `Zinc: ${avg.zinc_mg}/${FERTILITY_TARGETS.zinc_mg}mg (${pct(avg.zinc_mg, FERTILITY_TARGETS.zinc_mg)}%)\n`;
    msg += `Selenium: ${avg.selenium_mcg}/${FERTILITY_TARGETS.selenium_mcg}mcg (${pct(avg.selenium_mcg, FERTILITY_TARGETS.selenium_mcg)}%)\n`;
    msg += `Omega-3: ${avg.omega3_mg}/${FERTILITY_TARGETS.omega3_mg}mg (${pct(avg.omega3_mg, FERTILITY_TARGETS.omega3_mg)}%)\n`;
    msg += `Folate: ${avg.folate_mcg}/${FERTILITY_TARGETS.folate_mcg}mcg (${pct(avg.folate_mcg, FERTILITY_TARGETS.folate_mcg)}%)\n`;
    msg += `Vit C: ${avg.vitamin_c_mg}/${FERTILITY_TARGETS.vitamin_c_mg}mg (${pct(avg.vitamin_c_mg, FERTILITY_TARGETS.vitamin_c_mg)}%)`;
  }

  return msg;
}

interface AiResult {
  reply: string;
  calories: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  zinc_mg: number;
  selenium_mcg: number;
  omega3_mg: number;
  folate_mcg: number;
  vitamin_c_mg: number;
}

async function analyzeFoodText(
  foodText: string,
  user: UserProfile,
  previousTotals: DailyTotals,
  foodListSoFar: string
): Promise<AiResult> {
  const contextNote =
    foodListSoFar.length > 0
      ? `ก่อนหน้ามื้อนี้ วันนี้กินไปแล้ว: ${foodListSoFar} รวมพลังงานประมาณ ${previousTotals.calories} แคล โปรตีน ${previousTotals.protein_g} กรัม`
      : "วันนี้ยังไม่มีข้อมูลมื้อก่อนหน้า ถือว่าเป็นมื้อแรกของวัน";

  const profileNote = `ผู้ใช้เพศ${user.gender === "male" ? "ชาย" : "หญิง"} อายุ ${user.age} ปี น้ำหนัก ${user.weight_kg} กก. ส่วนสูง ${user.height_cm} ซม. เป้าหมายหลักคือ "${user.goal}"`;

  const fertilityInstruction =
    user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ"
      ? "เน้นชี้จุดที่เกี่ยวกับ zinc, selenium, omega-3, folate, vitamin C ในทุกคำตอบ"
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
            "ตอบกลับเป็น JSON เท่านั้น ตามโครงสร้างนี้:\n" +
            '{"reply": "ข้อความภาษาไทย กระชับ", "calories": ตัวเลข, "protein_g": ตัวเลข, "carb_g": ตัวเลข, "fat_g": ตัวเลข, "zinc_mg": ตัวเลข, "selenium_mcg": ตัวเลข, "omega3_mg": ตัวเลข, "folate_mcg": ตัวเลข, "vitamin_c_mg": ตัวเลข}\n\n' +
            "ตัวเลขทั้งหมด = ค่าประมาณรวมของทุกเมนูที่กล่าวถึงในข้อความนี้ ปรับตามปริมาณจริงที่ผู้ใช้บอก (เช่น 'ครึ่งซอง' 'กินไม่หมด') เป็นจำนวนเต็ม ถ้าเมนูไม่มีสารอาหารตัวนั้นเลยให้ใส่ 0\n\n" +
            "แนวทางประมาณสารอาหารสำคัญ (คร่าวๆ พอ ไม่ต้องแม่นระดับห้องแล็บ):\n" +
            "- zinc_mg: สูงในหอยนางรม เนื้อแดง ไข่ ถั่ว เมล็ดฟักทอง\n" +
            "- selenium_mcg: สูงในอาหารทะเล ไข่ เครื่องใน ธัญพืชไม่ขัดสี\n" +
            "- omega3_mg: สูงในปลาทะเลน้ำลึก (แซลมอน ทูน่า ปลาซาบะ) วอลนัท เมล็ดแฟลกซ์\n" +
            "- folate_mcg: สูงในผักใบเขียวเข้ม ถั่ว ตับ\n" +
            "- vitamin_c_mg: สูงในผลไม้รสเปรี้ยว ฝรั่ง พริกหวาน มะละกอ\n\n" +
            "เมื่อประมาณปริมาณอาหาร ให้สมมติเป็นปริมาณมาตรฐาน 1 หน่วย (จาน/ชาม/แก้ว/ลูก/ฟอง/แผ่น/ที่) เว้นแต่ผู้ใช้ระบุปริมาณต่างจากมาตรฐานเอง (เช่น ครึ่งซอง กินไม่หมด 2 จาน) ให้ปรับตัวเลขตามนั้น และระบุปริมาณที่ใช้ในคำตอบเสมอ\n\n" +
            "ใน 'reply' ต้องมีครบทุกข้อนี้เสมอ ห้ามข้าม:\n" +
            "1. ชื่อเมนู + ปริมาณที่สมมติ/ที่ผู้ใช้ระบุ + ค่าพลังงานโดยประมาณเป็นตัวเลขชัดเจน พร้อมโปรตีนโดยประมาณเป็นตัวเลข ห้ามพูดลอยๆ โดยไม่มีตัวเลขเด็ดขาด\n" +
            "2. ข้อสังเกตตามเป้าหมาย/fertility ของมื้อนี้\n" +
            "3. คำแนะนำมื้อถัดไปสั้นๆ\n\n" +
            "**ห้ามพูดถึงยอดสะสมรวมทั้งวันในคำตอบเด็ดขาด ห้ามบวกเลขสะสมเอง** ระบบจะคำนวณยอดสะสมและต่อท้ายให้อัตโนมัติแยกต่างหาก\n\n" +
            `ข้อมูลผู้ใช้: ${profileNote}\n` +
            `คำแนะนำเรื่อง fertility: ${fertilityInstruction}\n` +
            `คำแนะนำเรื่องเป้าหมาย: ${goalInstruction}\n\n` +
            "ถ้าผู้ใช้พิมพ์เรื่องอื่นที่ไม่เกี่ยวกับอาหาร ตอบใน 'reply' แบบเพื่อนคุยสั้นๆ แล้วชวนกลับมาเรื่องอาหาร และให้ตัวเลขทั้งหมดเป็น 0\n\n" +
            "ห้ามพูดในเชิงฟันธงหรืออ้างว่าเป็นคำแนะนำทางการแพทย์ ตอบกระชับ ไม่เกิน 5-6 บรรทัด\n\n" +
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
      zinc_mg: Number(parsed.zinc_mg) || 0,
      selenium_mcg: Number(parsed.selenium_mcg) || 0,
      omega3_mg: Number(parsed.omega3_mg) || 0,
      folate_mcg: Number(parsed.folate_mcg) || 0,
      vitamin_c_mg: Number(parsed.vitamin_c_mg) || 0,
    };
  } catch {
    return {
      reply: "ขอโทษครับ วิเคราะห์ไม่สำเร็จ ลองส่งใหม่อีกครั้งนะครับ",
      calories: 0,
      protein_g: 0,
      carb_g: 0,
      fat_g: 0,
      zinc_mg: 0,
      selenium_mcg: 0,
      omega3_mg: 0,
      folate_mcg: 0,
      vitamin_c_mg: 0,
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
    zinc_mg: result.zinc_mg,
    selenium_mcg: result.selenium_mcg,
    omega3_mg: result.omega3_mg,
    folate_mcg: result.folate_mcg,
    vitamin_c_mg: result.vitamin_c_mg,
    ai_response: result.reply,
  });
}

function buildSummaryBlock(
  mealTotals: AiResult,
  previousTotals: DailyTotals,
  targetCalories: number | null,
  targetProtein: number | null,
  showFertilityMicros: boolean
): string {
  const newTotals: DailyTotals = {
    calories: previousTotals.calories + mealTotals.calories,
    protein_g: previousTotals.protein_g + mealTotals.protein_g,
    carb_g: previousTotals.carb_g + mealTotals.carb_g,
    fat_g: previousTotals.fat_g + mealTotals.fat_g,
    zinc_mg: previousTotals.zinc_mg + mealTotals.zinc_mg,
    selenium_mcg: previousTotals.selenium_mcg + mealTotals.selenium_mcg,
    omega3_mg: previousTotals.omega3_mg + mealTotals.omega3_mg,
    folate_mcg: previousTotals.folate_mcg + mealTotals.folate_mcg,
    vitamin_c_mg: previousTotals.vitamin_c_mg + mealTotals.vitamin_c_mg,
  };

  const caloriesLine = targetCalories
    ? (() => {
        const remaining = targetCalories - newTotals.calories;
        return remaining >= 0
          ? `แคล: ${newTotals.calories}/${targetCalories} (เหลืออีก ${remaining})`
          : `แคล: ${newTotals.calories}/${targetCalories} (เกินไป ${Math.abs(remaining)})`;
      })()
    : `แคล: ${newTotals.calories}`;

  const proteinLine = targetProtein
    ? `โปรตีน: ${newTotals.protein_g}/${targetProtein}g`
    : `โปรตีน: ${newTotals.protein_g}g`;

  let block = `\n\n📊 ยอดสะสมวันนี้`;
  block += `\n${caloriesLine}`;
  block += `\n${proteinLine}`;
  block += `\nคาร์บ: ${newTotals.carb_g}g`;
  block += `\nไขมัน: ${newTotals.fat_g}g`;

  if (showFertilityMicros) {
    block += `\n\n🎯 สารอาหารเพื่ออสุจิ`;
    block += `\nZinc: ${newTotals.zinc_mg}/${FERTILITY_TARGETS.zinc_mg}mg`;
    block += `\nSelenium: ${newTotals.selenium_mcg}/${FERTILITY_TARGETS.selenium_mcg}mcg`;
    block += `\nOmega-3: ${newTotals.omega3_mg}/${FERTILITY_TARGETS.omega3_mg}mg`;
    block += `\nFolate: ${newTotals.folate_mcg}/${FERTILITY_TARGETS.folate_mcg}mcg`;
    block += `\nVit C: ${newTotals.vitamin_c_mg}/${FERTILITY_TARGETS.vitamin_c_mg}mg`;
  }

  return block;
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
        const messageId = event.message.id as string;

        if (await isDuplicateMessage(messageId)) {
          continue;
        }

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

        const summaryRequest = detectSummaryRequest(userText);
        if (summaryRequest) {
          const days = summaryRequest === "week" ? 7 : 30;
          const periodLabel = summaryRequest === "week" ? "รายสัปดาห์" : "รายเดือน";
          const stats = await getPeriodStats(userId, days);
          const showFertilityMicros = user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ";
          const summaryText = buildPeriodSummary(
            periodLabel,
            days,
            stats,
            user.target_calories,
            user.target_protein_g,
            showFertilityMicros
          );
          await replyMessage(replyToken, summaryText);
          continue;
        }

        const { totals: previousTotals, foodList } = await getTodayTotals(userId);
        const result = await analyzeFoodText(userText, user, previousTotals, foodList);

        const isFoodMessage =
          result.calories !== 0 || result.protein_g !== 0 || result.carb_g !== 0 || result.fat_g !== 0;

        const showFertilityMicros = user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ";

        const finalReply = isFoodMessage
          ? result.reply +
            buildSummaryBlock(result, previousTotals, user.target_calories, user.target_protein_g, showFertilityMicros)
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