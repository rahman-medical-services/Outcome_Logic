import OpenAI from 'openai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// Vercel Serverless Config
export const config = { 
    api: { bodyParser: { sizeLimit: '4mb' } } 
};

const githubAi = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: process.env.GITHUB_TOKEN
});

// ==========================================
// 1. THE PROMPTS (Deep Clinical Extraction)
// ==========================================
const EXTRACTOR_PROMPT = `You are a Surgical Data Extraction Agent analyzing a FULL-TEXT clinical trial. 
Extract detailed PICO data, baseline demographics, secondary outcomes, and adverse events. 
Identify the primary endpoint and extract its statistical significance (p-values, HRs, CIs).
If there is a survival or time-to-event analysis (Kaplan-Meier), extract the cumulative incidence or survival percentages at multiple specific time intervals (e.g., 0, 30, 60, 90 days) for all arms.
Assess methodological limitations and Risk of Bias.`;

const ADJUDICATOR_PROMPT = `You are the Chief of Surgery and an EBM expert.
Compare the two provided extraction reports. Resolve discrepancies and create a single, unified synthesis.
You MUST output STRICTLY in this JSON schema:
{
  "metadata": { "trial_identification": "String", "study_design": "String" },
  "clinician_view": {
    "context": { "clinical_background": "String", "what_this_adds": "String" },
    "pico": { 
      "population": "String", 
      "intervention": "String", 
      "control": "String", 
      "primary_outcome": "String",
      "secondary_outcomes": ["String"]
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
          "axes": {"x_label": "String", "y_label": "String"}, 
          "arms": [ 
            { 
              "group_name": "String", 
              "data_points": [ {"x": "String", "y": 0} ] 
            } 
          ] 
        }
      ]
    }
  }
}

CRITICAL INSTRUCTIONS FOR KAPLAN-MEIER:
1. Use 'stepped-line' for survival/time-to-event data.
2. Provide 4-5 data points (e.g., '0d', '30d', '60d', '90d') to form a proper curve.
3. Ensure y-values are numeric (e.g., 0.95 for 95%).
4. If data is missing for a timepoint, estimate based on the trend or mark as null.`;

// ==========================================
// 2. DATA FETCHING ROUTERS
// ==========================================
async function fetchTrialData(query, isPmid = false) {
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Europe PMC unreachable.");
    const data = await response.json();
    if (!data.resultList?.result?.length) return "Error: No trial found.";
    const article = data.resultList.result[0];
    const abstract = article.abstractText ? article.abstractText.replace(/<[^>]*>?/gm, '') : "No abstract.";
    return `TITLE: ${article.title}\n\nABSTRACT: ${abstract}`;
}

async function fetchFromUrl(targetUrl) {
    const response = await fetch(`https://r.jina.ai/${targetUrl}`);
    if (!response.ok) throw new Error("URL extraction failed.");
    return await response.text();
}

async function extractTextFromPDF(base64Data) {
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    const data = await pdfParse(pdfBuffer);
    return data.text;
}

// ==========================================
// 3. MAIN HANDLER
// ==========================================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { inputPayload, isPdf } = req.body;
        let textToAnalyze = "";
        let dataSource = "";

        if (isPdf) {
            dataSource = "Full-Text PDF";
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
                dataSource = "Pasted Text";
                textToAnalyze = trimmed;
            }
        }

        // Truncate to stay within 8k token limit (Source + Prompts + Response)
        if (textToAnalyze.length > 18000) textToAnalyze = textToAnalyze.substring(0, 18000);
        const sourceContext = `[SOURCE: ${dataSource}]\n\n${textToAnalyze}`;

        // NODE 1 & 2: Parallel Extraction
        const [reportA, reportB] = await Promise.all([
            githubAi.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: EXTRACTOR_PROMPT }, { role: "user", content: sourceContext }],
                temperature: 0.1
            }).then(res => res.choices[0].message.content),
            githubAi.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: EXTRACTOR_PROMPT }, { role: "user", content: sourceContext }],
                temperature: 0.2
            }).then(res => res.choices[0].message.content)
        ]);

        // NODE 3: Adjudication (Smart Truncation: No source text passed here to save tokens)
        const adjudicationPrompt = `Compare these two reports and generate the final unified JSON.
        
        REPORT A: ${reportA}
        
        REPORT B: ${reportB}`;

        const finalResponse = await githubAi.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: ADJUDICATOR_PROMPT }, { role: "user", content: adjudicationPrompt }],
            response_format: { type: "json_object" }, 
            temperature: 0.0
        });

        return res.status(200).json(JSON.parse(finalResponse.choices[0].message.content));

    } catch (error) {
        console.error("API Error:", error);
        return res.status(500).json({ error: "Processing failed.", details: error.message });
    }
}