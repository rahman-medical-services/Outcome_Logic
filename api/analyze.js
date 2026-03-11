import OpenAI from 'openai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const githubAi = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: process.env.GITHUB_TOKEN
});

// ==========================================
// THE PROMPTS (Deep Clinical Extraction)
// ==========================================
const EXTRACTOR_PROMPT = `You are a Surgical Data Extraction Agent analyzing a FULL-TEXT clinical trial. 
Extract detailed PICO data, baseline demographics, secondary outcomes, and adverse events. 
Identify the primary endpoint and extract its statistical significance (p-values, HRs, CIs).
If there is a survival or time-to-event analysis (Kaplan-Meier), extract the cumulative incidence or survival percentages at multiple specific time intervals for both arms.
Assess methodological limitations and Risk of Bias.`;

const ADJUDICATOR_PROMPT = `You are the Chief of Surgery and an EBM expert.
Synthesize the Extractor reports against the Source Text. 
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
      "secondary_outcomes": ["String", "String"]
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

CRITICAL INSTRUCTIONS FOR KAPLAN-MEIER CURVES:
If recommending 'stepped-line', the 'data_points' array MUST contain multiple time-series steps. For example, x: '0 months', y: 100; x: '12 months', y: 85; x: '24 months', y: 70. Ensure the 'x' values are identical across all arms to align the chart axes.`;

// ==========================================
// ROUTERS (Europe PMC, URL, and PDF)
// ==========================================
async function fetchTrialData(query, isPmid = false) {
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch data from Europe PMC.");
    const data = await response.json();
    if (!data.resultList || !data.resultList.result || data.resultList.result.length === 0) return "Error: No trial data found.";
    const article = data.resultList.result[0];
    const abstract = article.abstractText ? article.abstractText.replace(/<[^>]*>?/gm, '') : "No abstract available.";
    return `TITLE: ${article.title || "Unknown"}\n\nABSTRACT:\n${abstract}`;
}

async function fetchFromUrl(targetUrl) {
    const jinaUrl = `https://r.jina.ai/${targetUrl}`;
    const response = await fetch(jinaUrl);
    if (!response.ok) throw new Error("Failed to extract text from URL.");
    return await response.text();
}

async function extractTextFromPDF(base64Data) {
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    const data = await pdfParse(pdfBuffer);
    return data.text;
}

// ==========================================
// MAIN API HANDLER
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
        let dataSource = "Raw Text";

        if (isPdf) {
            dataSource = "Uploaded Full-Text PDF";
            textToAnalyze = await extractTextFromPDF(inputPayload);
        } else {
            const inputTrimmed = inputPayload.trim();
            if (/^\d{7,8}$/.test(inputTrimmed)) {
                dataSource = `EuropePMC (PMID: ${inputTrimmed})`;
                textToAnalyze = await fetchTrialData(inputTrimmed, true);
            } else if (inputTrimmed.startsWith('http://') || inputTrimmed.startsWith('https://')) {
                dataSource = `Web Extraction (${inputTrimmed})`;
                textToAnalyze = await fetchFromUrl(inputTrimmed);
            } else if (inputTrimmed.length < 150) {
                dataSource = `EuropePMC Search (${inputTrimmed})`;
                textToAnalyze = await fetchTrialData(inputTrimmed, false);
            } else {
                dataSource = "Pasted Raw Text";
                textToAnalyze = inputTrimmed;
            }
        }

        // Free tier limitation (methods, results, tables)
        if (textToAnalyze.length > 25000) textToAnalyze = textToAnalyze.substring(0, 25000);

        const sourceContext = `[SOURCE: ${dataSource}]\n\n${textToAnalyze}`;

        const [extractorAResult, extractorBResult] = await Promise.all([
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

        const adjudicationPrompt = `
        SOURCE TEXT:\n${sourceContext}\n\n
        ---
        EXTRACTOR A:\n${extractorAResult}\n\n
        ---
        EXTRACTOR B:\n${extractorBResult}\n\n
        ---
        Adjudicate and output the final JSON payload.`;

        const finalResponse = await githubAi.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: ADJUDICATOR_PROMPT }, { role: "user", content: adjudicationPrompt }],
            response_format: { type: "json_object" }, 
            temperature: 0.0
        });

        const jsonResult = JSON.parse(finalResponse.choices[0].message.content);
        return res.status(200).json(jsonResult);

    } catch (error) {
        console.error("Outcomelogic API Error:", error);
        return res.status(500).json({ error: "Failed to process the text.", details: error.message });
    }
}