// LLM thread distiller — extracts Q&A pairs from conversation threads.
// Source-agnostic: takes structured messages, returns structured Q&A pairs.

import OpenAI from "openai";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ThreadMessage {
  author: string;
  content: string;
  timestamp: string;
  reactions?: Array<{ name: string; count: number }>;
}

export interface DistilledPair {
  question: string;
  answer: string;
  confidence: number; // 0.0 - 1.0
}

export interface DistillerResult {
  pairs: DistilledPair[];
}

export interface DistillerOptions {
  model?: string;
  maxMessages?: number;
  apiKey?: string;
  client?: OpenAI;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_MESSAGES = 100;

const SYSTEM_PROMPT = `You are a Q&A extraction engine. Given a conversation thread, identify distinct question-answer pairs.

For each pair:
1. Extract the core question (rephrase if needed for clarity)
2. Extract the best answer (synthesize from multiple replies if needed)
3. Score confidence from 0.0 to 1.0 based on:
   - Answer completeness (does it fully address the question?)
   - Questioner satisfaction signals ("thanks", "that worked", etc.)
   - Community validation (reactions like thumbsup, check marks)
   - Answer specificity (concrete steps vs vague suggestions)

Return JSON with this exact structure:
{
  "pairs": [
    {
      "question": "How do I configure X?",
      "answer": "You can configure X by...",
      "confidence": 0.85
    }
  ]
}

Rules:
- A thread may contain multiple Q&A pairs (follow-up questions)
- Skip greetings, pleasantries, and off-topic tangents
- If no clear Q&A exists, return {"pairs": []}
- Keep answers concise but complete (aim for 1-3 paragraphs)
- Preserve code blocks, URLs, and technical details from answers
- Confidence below 0.3 means the answer is likely incomplete or wrong`;

// ── Distiller ────────────────────────────────────────────────────────────────

/**
 * Distill a conversation thread into Q&A pairs using an LLM.
 */
export async function distillThread(
  messages: ThreadMessage[],
  options?: DistillerOptions,
): Promise<DistillerResult> {
  const model = options?.model ?? DEFAULT_MODEL;
  const maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;

  if (messages.length === 0) {
    return { pairs: [] };
  }

  // Truncate to max messages
  const truncated = messages.slice(0, maxMessages);

  // Format as conversation transcript
  const transcript = truncated
    .map((msg) => {
      const reactions =
        msg.reactions && msg.reactions.length > 0
          ? ` [reactions: ${msg.reactions.map((r) => `:${r.name}: x${r.count}`).join(", ")}]`
          : "";
      return `[${msg.timestamp}] ${msg.author}: ${msg.content}${reactions}`;
    })
    .join("\n\n");

  const client = options?.client ?? new OpenAI({ apiKey: options?.apiKey });

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.warn("[distiller] Empty response from LLM");
      return { pairs: [] };
    }

    const parsed = JSON.parse(content);

    // Validate structure
    if (!Array.isArray(parsed.pairs)) {
      console.warn(
        "[distiller] Invalid response structure — missing pairs array",
      );
      return { pairs: [] };
    }

    // Validate and filter each pair
    const validPairs: DistilledPair[] = [];
    for (const pair of parsed.pairs) {
      if (
        typeof pair.question === "string" &&
        pair.question.trim() &&
        typeof pair.answer === "string" &&
        pair.answer.trim() &&
        typeof pair.confidence === "number" &&
        pair.confidence >= 0 &&
        pair.confidence <= 1
      ) {
        validPairs.push({
          question: pair.question.trim(),
          answer: pair.answer.trim(),
          confidence: pair.confidence,
        });
      } else {
        console.warn(
          "[distiller] Skipping malformed pair:",
          JSON.stringify(pair).slice(0, 200),
        );
      }
    }

    return { pairs: validPairs };
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(
        "[distiller] Failed to parse LLM JSON response:",
        error.message,
      );
      return { pairs: [] };
    }
    throw error; // Re-throw API errors for caller to handle
  }
}
