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

async function showLoadingAnimation(userId: string, seconds: number) {
  try {
    await fetch("https://api.line.me/v2/bot/chat/loading/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ chatId: userId, loadingSeconds: seconds }),
    });
  } catch (e) {
    console.error("loading animation failed:", e);
  }
}

async function isDuplicateMessage(messageId: string): Promise<boolean> {
  const { error } = await supabase.from("processed_messages").insert({ message_id: messageId });
  if (error) {
    if (error.code === "23505") return true;
    console.error("dedup check error:", error);
    return false;
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

const WELCOME_TEXT =
  "สวัสดีครับ ผมกินเป็น 🙂\nเป็น AI ผู้ช่วยเรื่องกินและโภชนาการ ใช้ง่ายมาก แค่พิมพ์บอกว่ากินอะไรมา ผมจะช่วยประมาณแคลอรี่และสารอาหารให้ พร้อมจดจำได้ว่าวันนี้กินอะไรไปแล้วบ้าง\n\nก่อนเริ่ม ขอถามข้อมูลนิดหน่อยเพื่อแนะนำได้ตรงจุดนะครับ\n\nคุณเป็นเพศอะไรครับ?";

const HELP_TEXT =
  "📖 วิธีใช้กินเป็น\n\n" +
  "🍽️ บอกว่ากินอะไร — พิมพ์ชื่อเมนูตรงๆ เช่น 'ข้าวกะเพราหมู' ผมจะประมาณแคลอรี่และสารอาหารให้ พร้อมจำสะสมไว้ทั้งวัน\n\n" +
  "💬 ปรึกษาเรื่องอาหาร — ถามได้เลย เช่น 'วันนี้กินอะไรดี' 'ไก่ย่างดีไหม' 'มีอะไรถูกๆ ดีๆ แนะนำไหม'\n\n" +
  "📊 ดูสรุปยอด — พิมพ์ 'สรุปยอดวันนี้' 'สรุปรายอาทิตย์' หรือ 'สรุปเดือนนี้'\n\n" +
  "🗑️ ลบมื้อ — พิมพ์ 'ยังไม่ได้กิน [ชื่ออาหาร]' หรือแค่ 'ยังไม่ได้กิน' เพื่อลบมื้อล่าสุด ลบหลายอย่างพร้อมกันได้ (คั่นด้วยจุลภาค ขึ้นบรรทัดใหม่ หรือเว้นวรรคก็ได้)\n\n" +
  "✏️ แก้ไขข้อมูลที่บันทึกผิด — ให้ลบของเดิมก่อนเสมอ (เช่น 'ลบ นม') แล้วค่อยพิมพ์รายการใหม่ที่ถูกต้อง ระบบยังไม่รองรับการแก้ไขทับข้อความเดิมโดยตรง\n\n" +
  "💡 กินหลายอย่างพร้อมกัน — ถ้าอยากให้แยกแม่นขึ้น คั่นด้วยจุลภาคหรือใส่ปริมาณกำกับ เช่น 'ธัญพืช 1 ห่อ, โยเกิร์ต 1 ถ้วย' แทนที่จะพิมพ์ติดกันเฉยๆ\n\n" +
  "🗣️ คุยเล่นได้ — ผมคุยเรื่องทั่วไปได้บ้าง แต่ถนัดเรื่องอาหาร/สุขภาพเป็นหลัก\n\n" +
  "พิมพ์ 'help' เมื่อไหร่ก็เรียกดูอันนี้ได้อีกครับ";

function isHelpRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/["'“”‘’.!?]/g, "");
  const helpPhrases = ["help", "ช่วยเหลือ", "คำสั่ง", "วิธีใช้", "วิธีใช้งาน", "สอนใช้งาน", "ใช้ยังไง"];
  return helpPhrases.includes(t);
}

function isUndoRequest(text: string): boolean {
  const t = text.trim();
  const undoPhrases = ["ลบมื้อล่าสุด", "ลบรายการล่าสุด", "ลบอันล่าสุด", "ยังไม่ได้กิน", "แก้ไขมื้อล่าสุด", "ลบมื้อที่แล้ว"];
  if (undoPhrases.some((phrase) => t.includes(phrase))) return true;
  if (t.startsWith("ลบ")) return true;
  if (t.includes("ไม่ได้กิน") || t.includes("ไม่ได้ทาน")) return true;
  return false;
}

const GENERIC_UNDO_WORDS = ["มื้อล่าสุด", "รายการล่าสุด", "อันล่าสุด", "มื้อที่แล้ว", "ล่าสุด", ""];

function extractUndoTargetRaw(text: string): string | null {
  const t = text.trim();
  const patterns = [/ยังไม่ได้กิน([\s\S]+)/, /ยังไม่ได้ทาน([\s\S]+)/, /ไม่ได้กิน([\s\S]+)/, /ไม่ได้ทาน([\s\S]+)/, /^ลบ([\s\S]+)/];
  for (const p of patterns) {
    const m = t.match(p);
    if (m && m[1]) {
      const raw = m[1].trim();
      if (GENERIC_UNDO_WORDS.includes(raw)) return null;
      return raw;
    }
  }
  return null;
}

async function undoMeals(userId: string, rawTarget: string | null): Promise<string> {
  const startOfDayISO = getThailandStartOfDayISO();

  const { data, error } = await supabase
    .from("food_logs")
    .select("id, food_text, calories")
    .eq("user_id", userId)
    .gte("created_at", startOfDayISO)
    .order("created_at", { ascending: false });

  if (error || !data || data.length === 0) {
    return "วันนี้ยังไม่มีรายการอาหารให้ลบเลยครับ 🙂";
  }

  if (!rawTarget) {
    const target = data[0];
    await supabase.from("food_logs").delete().eq("id", target.id);
    return `ลบ "${target.food_text}" ออกจากบันทึกวันนี้แล้วครับ ✅ ยอดสะสมอัปเดตให้อัตโนมัติแล้ว`;
  }

  const explicitSegments = rawTarget
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (explicitSegments.length > 1) {
    const deleted: string[] = [];
    const notFound: string[] = [];
    const usedIds = new Set<string>();

    for (const seg of explicitSegments) {
      const match = data.find((row) => !usedIds.has(row.id) && row.food_text.includes(seg));
      if (match) {
        usedIds.add(match.id);
        deleted.push(match.food_text);
      } else {
        notFound.push(seg);
      }
    }

    if (usedIds.size > 0) {
      await supabase.from("food_logs").delete().in("id", Array.from(usedIds));
    }

    let msg = "";
    if (deleted.length > 0) msg += `ลบแล้ว: ${deleted.join(", ")} ✅`;
    if (notFound.length > 0) msg += `${msg ? "\n" : ""}หาไม่เจอ: ${notFound.join(", ")}`;
    return msg || "ไม่พบรายการที่ตรงกันเลยครับ";
  }

  const sortedByLength = [...data].sort((a, b) => b.food_text.length - a.food_text.length);
  const matched: typeof data = [];
  let remaining = rawTarget;

  for (const candidate of sortedByLength) {
    const name = candidate.food_text.trim();
    if (name.length > 0 && remaining.includes(name)) {
      matched.push(candidate);
      remaining = remaining.split(name).join(" ");
    }
  }

  if (matched.length > 1) {
    await supabase.from("food_logs").delete().in("id", matched.map((m) => m.id));
    return `ลบแล้ว: ${matched.map((m) => m.food_text).join(", ")} ✅`;
  }

  if (matched.length === 1) {
    await supabase.from("food_logs").delete().eq("id", matched[0].id);
    return `ลบ "${matched[0].food_text}" ออกจากบันทึกวันนี้แล้วครับ ✅ ยอดสะสมอัปเดตให้อัตโนมัติแล้ว`;
  }

  const allMatches = data.filter((row) => row.food_text.includes(rawTarget));
  if (allMatches.length === 1) {
    await supabase.from("food_logs").delete().eq("id", allMatches[0].id);
    return `ลบ "${allMatches[0].food_text}" ออกจากบันทึกวันนี้แล้วครับ ✅ ยอดสะสมอัปเดตให้อัตโนมัติแล้ว`;
  }
  if (allMatches.length > 1) {
    const listWithCal = allMatches.map((m, i) => `${i + 1}. ${m.food_text} (${m.calories} แคล)`).join("\n");
    return `เจอหลายรายการที่ตรงกับ "${rawTarget}" ครับ ระบุให้ชัดกว่านี้หน่อยได้ไหม เช่น พิมพ์ตามชื่อเต็ม:\n${listWithCal}`;
  }

  const list = data.map((r) => r.food_text).join(", ");
  return `หารายการที่ตรงกับ "${rawTarget}" ในวันนี้ไม่เจอครับ วันนี้บันทึกไว้: ${list}\n\nลองพิมพ์ชื่อให้ตรงกับที่บันทึกไว้ดูอีกครั้งนะครับ`;
}

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
      `เรียบร้อยครับ! 🎉\n\nจากข้อมูลของคุณ เป้าหมายพลังงานต่อวันอยู่ที่ประมาณ ${targetCalories} แคล โปรตีนประมาณ ${targetProtein} กรัม${extraNote}\n\n(ค่าประมาณกลางๆ ยังไม่รวมระดับกิจกรรมจริง ใช้เป็นแนวทางได้เลยครับ)\n\nลองส่งเมนูที่กินมาได้เลยครับ หรือพิมพ์ 'help' เพื่อดูวิธีใช้ทั้งหมดนะครับ`
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

function roundTotals(raw: DailyTotals): DailyTotals {
  return {
    calories: raw.calories,
    protein_g: raw.protein_g,
    carb_g: raw.carb_g,
    fat_g: raw.fat_g,
    zinc_mg: Math.round(raw.zinc_mg * 10) / 10,
    selenium_mcg: Math.round(raw.selenium_mcg * 10) / 10,
    omega3_mg: Math.round(raw.omega3_mg * 10) / 10,
    folate_mcg: Math.round(raw.folate_mcg * 10) / 10,
    vitamin_c_mg: Math.round(raw.vitamin_c_mg * 10) / 10,
  };
}

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

  const raw = data.reduce(
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
  return { totals: roundTotals(raw), foodList };
}

function detectSummaryRequest(text: string): "day" | "week" | "month" | null {
  const t = text.trim();
  if (!/สรุป/.test(t)) return null;
  if (/เดือน|30\s*วัน/.test(t)) return "month";
  if (/อาทิตย์|สัปดาห์|7\s*วัน/.test(t)) return "week";
  return "day";
}

function buildDailySummaryReply(
  totals: DailyTotals,
  foodList: string,
  targetCalories: number | null,
  targetProtein: number | null,
  showFertilityMicros: boolean
): string {
  if (!foodList) {
    return "วันนี้ยังไม่มีการบันทึกอาหารเลยครับ พิมพ์บอกมาได้เลยว่ากินอะไรไปแล้วบ้าง 🙂";
  }

  const caloriesLine = targetCalories
    ? (() => {
        const remaining = targetCalories - totals.calories;
        return remaining >= 0
          ? `แคล: ${totals.calories}/${targetCalories} (เหลืออีก ${remaining})`
          : `แคล: ${totals.calories}/${targetCalories} (เกินไป ${Math.abs(remaining)})`;
      })()
    : `แคล: ${totals.calories}`;

  const proteinLine = targetProtein
    ? `โปรตีน: ${totals.protein_g}/${targetProtein}g`
    : `โปรตีน: ${totals.protein_g}g`;

  let msg = `📊 สรุปยอดวันนี้\n\nกินไปแล้ว: ${foodList}\n\n`;
  msg += `${caloriesLine}\n${proteinLine}\nคาร์บ: ${totals.carb_g}g\nไขมัน: ${totals.fat_g}g`;

  if (showFertilityMicros) {
    msg += `\n\n🎯 สารอาหารเพื่ออสุจิ`;
    msg += `\nZinc: ${totals.zinc_mg}/${FERTILITY_TARGETS.zinc_mg}mg`;
    msg += `\nSelenium: ${totals.selenium_mcg}/${FERTILITY_TARGETS.selenium_mcg}mcg`;
    msg += `\nOmega-3: ${totals.omega3_mg}/${FERTILITY_TARGETS.omega3_mg}mg`;
    msg += `\nFolate: ${totals.folate_mcg}/${FERTILITY_TARGETS.folate_mcg}mcg`;
    msg += `\nVit C: ${totals.vitamin_c_mg}/${FERTILITY_TARGETS.vitamin_c_mg}mg`;
  }

  return msg;
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

  const raw = data.reduce(
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

  return { totals: roundTotals(raw), daysLogged: loggedDates.size };
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
    zinc_mg: Math.round((stats.totals.zinc_mg / days) * 10) / 10,
    selenium_mcg: Math.round((stats.totals.selenium_mcg / days) * 10) / 10,
    omega3_mg: Math.round((stats.totals.omega3_mg / days) * 10) / 10,
    folate_mcg: Math.round((stats.totals.folate_mcg / days) * 10) / 10,
    vitamin_c_mg: Math.round((stats.totals.vitamin_c_mg / days) * 10) / 10,
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

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

async function getRecentChatHistory(userId: string, limit = 6): Promise<ChatMessage[]> {
  const sevenDaysAgoISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content")
    .eq("user_id", userId)
    .gte("created_at", sevenDaysAgoISO)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.reverse().map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));
}

async function saveChatMessage(userId: string, role: "user" | "assistant", content: string) {
  await supabase.from("chat_messages").insert({ user_id: userId, role, content });
}

interface FoodItem {
  name: string;
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

interface AiResult {
  reply: string;
  items: FoodItem[];
}

async function analyzeFoodText(
  foodText: string,
  user: UserProfile,
  previousTotals: DailyTotals,
  foodListSoFar: string,
  chatHistory: ChatMessage[]
): Promise<AiResult> {
  const contextNote =
    foodListSoFar.length > 0
      ? `วันนี้กินไปแล้ว: ${foodListSoFar} รวมพลังงานประมาณ ${previousTotals.calories} แคล โปรตีน ${previousTotals.protein_g} กรัม (ตัวเลขนี้ไม่รวมข้อความปัจจุบัน)`
      : "วันนี้ยังไม่มีข้อมูลมื้อก่อนหน้าเลย";

  const profileNote = `ผู้ใช้เพศ${user.gender === "male" ? "ชาย" : "หญิง"} อายุ ${user.age} ปี น้ำหนัก ${user.weight_kg} กก. ส่วนสูง ${user.height_cm} ซม. เป้าหมายหลักคือ "${user.goal}"`;

  const fertilityInstruction =
    user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ"
      ? "เน้นชี้จุดที่เกี่ยวกับ zinc, selenium, omega-3, folate, vitamin C เสมอ"
      : user.gender === "male"
      ? "ถ้าเกี่ยวกับสุขภาพสืบพันธุ์เพศชายชัดเจน พูดถึงสั้นๆ ได้ แต่ไม่ต้องเน้น"
      : "ห้ามพูดเรื่องสุขภาพสืบพันธุ์เพศชายเด็ดขาด";

  const goalInstruction =
    user.goal === "ลดน้ำหนัก"
      ? "เน้นเตือนถ้าแคล/คาร์บสูง"
      : user.goal === "เพิ่มกล้าม/พลังงาน"
      ? "เน้นเช็คว่าโปรตีนพอไหม"
      : "ให้คำแนะนำสมดุลทั่วไป";

  const historyMessages = chatHistory.map((m) => ({ role: m.role, content: m.content }));

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
            "คุณมีบทสนทนาล่าสุด (ถ้ามี) ส่งมาก่อนข้อความปัจจุบัน ใช้บริบทนั้นแค่เพื่อเข้าใจสถานการณ์และให้คำแนะนำต่อเนื่อง ไม่ใช่เพื่อนำมา log ซ้ำ\n\n" +
            "ตอบกลับเป็น JSON เท่านั้น ตามโครงสร้างนี้:\n" +
            '{"reply": "ข้อความภาษาไทย", "items": [{"name": "ชื่ออาหารสั้นๆ", "calories": ตัวเลข, "protein_g": ตัวเลข, "carb_g": ตัวเลข, "fat_g": ตัวเลข, "zinc_mg": ตัวเลข, "selenium_mcg": ตัวเลข, "omega3_mg": ตัวเลข, "folate_mcg": ตัวเลข, "vitamin_c_mg": ตัวเลข}]}\n\n' +
            "**กฎสำคัญเรื่อง items: ต้องมีเฉพาะรายการอาหารที่ถูกกล่าวถึงในข้อความปัจจุบันของผู้ใช้เท่านั้น ห้ามนำรายการอาหารจากบทสนทนาก่อนหน้ามาใส่ซ้ำใน items อีก แม้จะอ้างอิงถึงมันในข้อความ reply เพื่อความต่อเนื่องของบทสนทนาก็ตาม**\n\n" +
            "ผู้ใช้พิมพ์มาได้หลายแบบ แยกแยะและตอบตามนี้:\n\n" +
            "แบบที่ 1 — รายงานว่ากินอะไรไปแล้ว/กำลังกิน: ใส่ items ตามจริง ประมาณค่าพลังงาน/สารอาหารเป็นตัวเลขจริง ปรับตามปริมาณจริงที่บอก สมมติหน่วยมาตรฐานถ้าไม่ระบุ ใน reply พูดถึงชื่อเมนู+ปริมาณ+ค่าพลังงานตัวเลขชัดเจนพร้อมโปรตีน, ข้อสังเกตตามเป้าหมาย, คำแนะนำมื้อถัดไปสั้นๆ ห้ามพูดยอดสะสมรวมทั้งวันหรือบวกเลขเอง\n\n" +
            "แบบที่ 2 — ขอคำแนะนำ/ปรึกษาเรื่องอาหาร (ยังไม่ได้กิน): ตอบแบบเพื่อนที่รู้เรื่องอาหารจริงๆ แนะนำเมนูไทยจริงหาซื้อง่ายราคาไม่แพง คุยธรรมชาติ ไม่ต้องรีบสรุป **items ต้องเป็น array ว่าง [] เสมอ**\n\n" +
            "แบบที่ 3 — เรื่องทั่วไปไม่เกี่ยวอาหาร/สุขภาพเลย: คุยธรรมชาติสั้นๆ ห้ามใช้ประโยคจำเจแบบ 'มีอะไรอยากคุยไหม' ห้ามแปะคำแนะนำอาหารท้ายทุกประโยคแบบบังคับ ถ้าซับซ้อนต้องใช้ความรู้เฉพาะทางลึก บอกตรงๆ ว่าแนะนำให้ถามผู้เชี่ยวชาญหรือ ChatGPT ดีกว่า **items ต้องเป็น array ว่าง [] เสมอ**\n\n" +
            `ข้อมูลผู้ใช้: ${profileNote}\n` +
            `คำแนะนำเรื่อง fertility: ${fertilityInstruction}\n` +
            `คำแนะนำเรื่องเป้าหมาย: ${goalInstruction}\n\n` +
            "**กฎเหล็ก:** ตัวเลขในโครงสร้าง JSON เป็นข้อมูลภายในระบบเท่านั้น ห้ามพูดคำว่า 'ค่า' 'เป็น 0' 'ตัวแปร' ในข้อความ reply เด็ดขาด\n\n" +
            "ห้ามพูดเชิงฟันธงหรืออ้างว่าเป็นคำแนะนำทางการแพทย์ ตอบกระชับ ไม่เกิน 6-7 บรรทัด\n\n" +
            `ข้อมูลวันนี้: ${contextNote}`,
        },
        ...historyMessages,
        { role: "user", content: foodText },
      ],
    }),
  });

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  try {
    const parsed = JSON.parse(content);
    const round1 = (n: unknown) => Math.round((Number(n) || 0) * 10) / 10;
    const items: FoodItem[] = Array.isArray(parsed.items)
      ? parsed.items.map((it: Record<string, unknown>) => ({
          name: String(it.name || "อาหาร").slice(0, 100),
          calories: Math.round(Number(it.calories)) || 0,
          protein_g: Math.round(Number(it.protein_g)) || 0,
          carb_g: Math.round(Number(it.carb_g)) || 0,
          fat_g: Math.round(Number(it.fat_g)) || 0,
          zinc_mg: round1(it.zinc_mg),
          selenium_mcg: round1(it.selenium_mcg),
          omega3_mg: round1(it.omega3_mg),
          folate_mcg: round1(it.folate_mcg),
          vitamin_c_mg: round1(it.vitamin_c_mg),
        }))
      : [];
    return {
      reply: parsed.reply || "ขอโทษครับ วิเคราะห์ไม่สำเร็จ ลองส่งใหม่อีกครั้งนะครับ",
      items,
    };
  } catch {
    return {
      reply: "ขอโทษครับ วิเคราะห์ไม่สำเร็จ ลองส่งใหม่อีกครั้งนะครับ",
      items: [],
    };
  }
}

async function saveFoodItems(userId: string, items: FoodItem[], aiReply: string): Promise<boolean> {
  if (items.length === 0) return true;
  const rows = items.map((item) => ({
    user_id: userId,
    food_text: item.name,
    calories: item.calories,
    protein_g: item.protein_g,
    carb_g: item.carb_g,
    fat_g: item.fat_g,
    zinc_mg: item.zinc_mg,
    selenium_mcg: item.selenium_mcg,
    omega3_mg: item.omega3_mg,
    folate_mcg: item.folate_mcg,
    vitamin_c_mg: item.vitamin_c_mg,
    ai_response: aiReply,
  }));
  const { error } = await supabase.from("food_logs").insert(rows);
  if (error) {
    console.error("saveFoodItems failed:", error, { userId, items });
    return false;
  }
  return true;
}

function buildSummaryBlock(
  confirmationLine: string,
  newTotals: DailyTotals,
  targetCalories: number | null,
  targetProtein: number | null,
  showFertilityMicros: boolean
): string {
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

  let block = `\n\n${confirmationLine}`;
  block += `\n\n📊 ยอดสะสมวันนี้`;
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
      if (event.type === "follow") {
        const userId = event.source.userId;
        const replyToken = event.replyToken;
        const existingUser = await getUser(userId);
        if (!existingUser) {
          await createUser(userId);
          await replyMessage(replyToken, WELCOME_TEXT, ["ชาย", "หญิง"]);
        }
        continue;
      }

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
          await replyMessage(replyToken, WELCOME_TEXT, ["ชาย", "หญิง"]);
          continue;
        }

        if (user.onboarding_step !== "completed") {
          await handleOnboarding(userId, user, userText, replyToken);
          continue;
        }

        if (isHelpRequest(userText)) {
          await replyMessage(replyToken, HELP_TEXT);
          continue;
        }

        if (isUndoRequest(userText)) {
          const rawTarget = extractUndoTargetRaw(userText);
          const undoResult = await undoMeals(userId, rawTarget);
          await replyMessage(replyToken, undoResult);
          continue;
        }

        const summaryRequest = detectSummaryRequest(userText);
        if (summaryRequest) {
          const showFertilityMicros = user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ";

          if (summaryRequest === "day") {
            const { totals, foodList } = await getTodayTotals(userId);
            const summaryText = buildDailySummaryReply(
              totals,
              foodList,
              user.target_calories,
              user.target_protein_g,
              showFertilityMicros
            );
            await replyMessage(replyToken, summaryText);
            continue;
          }

          const days = summaryRequest === "week" ? 7 : 30;
          const periodLabel = summaryRequest === "week" ? "รายสัปดาห์" : "รายเดือน";
          const stats = await getPeriodStats(userId, days);
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

        await showLoadingAnimation(userId, 20);

        const [chatHistory, { totals: previousTotals, foodList }] = await Promise.all([
          getRecentChatHistory(userId),
          getTodayTotals(userId),
        ]);
        const result = await analyzeFoodText(userText, user, previousTotals, foodList, chatHistory);

        const isFoodMessage = result.items.length > 0;

        if (isFoodMessage) {
          const saved = await saveFoodItems(userId, result.items, result.reply);
          const itemNames = result.items.map((i) => i.name);
          const showFertilityMicros = user.gender === "male" && user.goal === "เพิ่มคุณภาพอสุจิ";

          if (saved) {
            const { totals: newTotals } = await getTodayTotals(userId);
            const confirmationLine = `✅ บันทึกแล้ว: ${itemNames.join(", ")}`;
            const finalReply =
              result.reply +
              buildSummaryBlock(
                confirmationLine,
                newTotals,
                user.target_calories,
                user.target_protein_g,
                showFertilityMicros
              );
            await replyMessage(replyToken, finalReply);
          } else {
            await replyMessage(
              replyToken,
              result.reply + "\n\n⚠️ ขอโทษครับ บันทึกมื้อนี้ไม่สำเร็จ (ปัญหาทางเทคนิค) ลองพิมพ์ส่งใหม่อีกครั้งนะครับ"
            );
          }
        } else {
          await replyMessage(replyToken, result.reply);
        }

        await Promise.all([
          saveChatMessage(userId, "user", userText),
          saveChatMessage(userId, "assistant", result.reply),
        ]);
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