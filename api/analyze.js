import { GoogleGenerativeAI } from '@google/generative-ai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ==========================================
// VERCEL SERVERLESS CONFIG
// ==========================================
export const config = {
    api: { bodyParser: { sizeLimit: '4mb' } }
};

// ==========================================
// SECURITY LAYER 3: Upstash Rate Limiter
// 25 requests per IP per 24-hour sliding window
// ==========================================
const ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(25, '24 h'),
    analytics: true,
    prefix: 'trial-visualiser',
});

// ==========================================
// CONSTANTS
// ==========================================
// Max characters fed into the adjudicator from each extractor report.
const EXTRACTOR_OUTPUT_CAP = 8000;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ==========================================
// PROMPTS
// ==========================================
const EXTRACTOR_PROMPT = `You are an elite Surgical Data Extraction Agent analyzing a FULL-TEXT clinical trial.
Extract detailed PICO data, baseline demographics, secondary outcomes, and adverse events.
Identify the primary endpoint and extract its statistical significance (p-values, HRs, CIs).

CRITICAL INSTRUCTION FOR KAPLAN-MEIER / SURVIVAL DATA:
You must reconstruct the survival/failure curve.
1. Scan the text for explicit time-point survival rates.
2. Hunt for "Number at risk" tables usually located below the Kaplan-Meier figures.
3. Use the baseline N, events, and number-at-risk at various time intervals to extract exact cumulative incidence or survival percentages.
4. Output these reconstructed step-coordinates clearly so the Adjudicator can format them into a stepped-line chart.

Assess methodological limitations and Risk of Bias.

Keep your output focused and concise. Do not reproduce full sections of the source text.`;

const ADJUDICATOR_PROMPT = `You are the Chief of Surgery and an EBM expert.
Compare the two provided extraction reports. Resolve discrepancies and create a single, unified synthesis.
You MUST output STRICTLY in this JSON schema:
{
  "metadata": { "trial_identification": "String", "study_design": "String" },
  "clinician_view": {
    "context": { "already_known": "String", "what_this_adds": "String" },
    "pico": {
      "population": "String", "intervention": "String", "control": "String",
      "primary_outcome": "String", "secondary_outcomes": ["String"]
    },
    "baseline_characteristics": "String",
    "critical_appraisal": { "grade_certainty": "String", "risk_of_bias": "String", "limitations": "String" },
    "interactive_data": {
      "endpoints": [
        {
          "id": "String",
          "label": "String",
          "recommended_chart_type": "bar|stepped-line",
          "clinical_synthesis": "String",
          "axes": { "x_label": "String", "y_label": "String" },
          "arms": [ { "group_name": "String", "data_points": [ { "x": "String", "y": 0 } ] } ]
        }
      ]
    }
  },
  "patient_view": {
    "lay_summary": "String",
    "shared_decision_making_takeaway": "String"
  }
}

CRITICAL INSTRUCTIONS FOR CONCISENESS:
- Be ruthless with word count. Use extremely concise, bullet-like phrasing.
- Maximum 1-2 short sentences for 'already_known', 'what_this_adds', and 'baseline_characteristics'.
- Limit 'secondary_outcomes' to only the 2 or 3 most clinically significant findings.

CRITICAL INSTRUCTIONS FOR KAPLAN-MEIER:
1. Use 'stepped-line' for survival/time-to-event data.
2. Provide 4-5 data points (e.g., '0d', '30d', '60d', '90d') to form a proper curve.
3. Ensure y-values are numeric (e.g., 0.95 for 95%).`;

// ==========================================
// DATA FETCHING ROUTERS
// ==========================================
// ==========================================
// DATA FETCHING ROUTERS
// ==========================================
async function fetchTrialData(query, isPmid = false) {
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Europe PMC unreachable.');
    const data = await response.json();
    if (!data.resultList?.result?.length) return 'Error: No trial found.';
    
    const article = data.resultList.result[0];

    // THE UPGRADE: If it has a PMCID, it is Open Access. Fetch the entire paper natively.
    if (article.pmcid) {
        try {
            // Route the PMC URL through our Jina web scraper to get clean markdown
            const pmcUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/${article.pmcid}/`;
            const fullTextResponse = await fetch(`https://r.jina.ai/${pmcUrl}`);
            if (fullTextResponse.ok) {
                const fullText = await fullTextResponse.text();
                return `TITLE: ${article.title}\n\n[FULL TEXT EXTRACTED VIA PMC]\n${fullText}`;
            }
        } catch (error) {
            console.error("Full text scrape failed, falling back to abstract.", error);
        }
    }

    // FALLBACK: If it's paywalled (no PMCID) or the scrape fails, grab the abstract.
    const abstract = article.abstractText ? article.abstractText.replace(/<[^>]*>?/gm, '') : 'No abstract available.';
    return `TITLE: ${article.title}\n\n[ABSTRACT ONLY - PAYWALLED]\n${abstract}`;
}

async function fetchFromUrl(targetUrl) {
    const response = await fetch(`https://r.jina.ai/${targetUrl}`);
    if (!response.ok) throw new Error('URL extraction failed.');
    return await response.text();
}

async function extractTextFromPDF(base64Data) {
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    const data = await pdfParse(pdfBuffer);
    return data.text;
}

function capExtractorOutput(text, maxChars = EXTRACTOR_OUTPUT_CAP) {
    if (text.length <= maxChars) return text;
    const trimmed = text.slice(0, maxChars);
    const lastSentence = trimmed.lastIndexOf('.');
    return lastSentence > 0 ? trimmed.slice(0, lastSentence + 1) : trimmed;
}

// ==========================================
// MAIN HANDLER
// ==========================================
export default async function handler(req, res) {
    // --- SECURITY LAYER 1: Open CORS (Browser fix) ---
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    // --- SECURITY LAYER 2: Secret Handshake Token ---
    const authToken = req.headers['x-api-token'];
    if (!authToken || authToken !== process.env.INTERNAL_API_TOKEN) {
        return res.status(401).json({ error: 'Unauthorised.' });
    }

    // --- SECURITY LAYER 3: IP Rate Limiting ---
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? '127.0.0.1';
    const { success, remaining } = await ratelimit.limit(ip);
    if (!success) {
        return res.status(429).json({
            error: 'Daily academic compute limit reached.',
            message: 'This tool is limited to 25 analyses per IP address per day to ensure availability for all users. Please try again tomorrow.'
        });
    }

    res.setHeader('X-RateLimit-Remaining', remaining);

    try {
        const { inputPayload, isPdf } = req.body;

        if (!inputPayload) {
            return res.status(400).json({ error: 'No input provided.' });
        }

        let textToAnalyze = '';
        let dataSource = '';

        if (isPdf) {
            dataSource = 'Full-Text PDF';
            textToAnalyze = await extractTextFromPDF(inputPayload);
        } else {
            const trimmed = inputPayload.trim();
            if (/^\d{7,8}$/.test(trimmed)) {
                dataSource = `PMID: ${trimmed}`;
                textToAnalyze = await fetchTrialData(trimmed, true);
            } else if (trimmed.startsWith('http')) {
                dataSource = `URL: ${trimmed}`;
                textToAnalyze = await fetchFromUrl(trimmed);
            } else if (trimmed.length < 150) {
                dataSource = `Search: ${trimmed}`;
                textToAnalyze = await fetchTrialData(trimmed, false);
            } else {
                dataSource = 'Pasted Text';
                textToAnalyze = trimmed;
            }
        }

        if (!textToAnalyze || textToAnalyze.startsWith('Error:')) {
            return res.status(404).json({ error: textToAnalyze || 'Could not retrieve trial data.' });
        }

        const sourceContext = `[SOURCE: ${dataSource}]\n\n${textToAnalyze}`;

        // --- NODE 1 & 2: Parallel Dual Extraction ---
        const extractorA = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: EXTRACTOR_PROMPT });
        const extractorB = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: EXTRACTOR_PROMPT });

        const [resultA, resultB] = await Promise.all([
            extractorA.generateContent({
                contents: [{ role: 'user', parts: [{ text: sourceContext }] }],
                generationConfig: { temperature: 0.1 }
            }),
            extractorB.generateContent({
                contents: [{ role: 'user', parts: [{ text: sourceContext }] }],
                generationConfig: { temperature: 0.2 }
            })
        ]);

        const reportA = capExtractorOutput(resultA.response.text());
        const reportB = capExtractorOutput(resultB.response.text());

        // --- NODE 3: Adjudication (Using Flash to bypass Pro's high traffic limits) ---
        const adjudicator = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: ADJUDICATOR_PROMPT,
            generationConfig: { responseMimeType: 'application/json', temperature: 0.0 }
        });

        const adjudicationInput = `Compare these two extraction reports and generate the final unified JSON.\n\nREPORT A:\n${reportA}\n\nREPORT B:\n${reportB}`;
        const finalResult = await adjudicator.generateContent(adjudicationInput);
        
        const parsed = JSON.parse(finalResult.response.text());
        parsed._provenance = { source: dataSource, timestamp: new Date().toISOString() };

        return res.status(200).json(parsed);

    } catch (error) {
        console.error('Pipeline error:', error);
        if (error instanceof SyntaxError) {
            return res.status(502).json({ error: 'AI returned malformed JSON. Please retry.', details: error.message });
        }
        return res.status(500).json({ error: 'Processing failed.', details: error.message });
    }
}