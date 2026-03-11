import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';

// ==========================================
// 1. INITIALIZE THE AI CLIENTS
// ==========================================
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const githubAi = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: process.env.GITHUB_TOKEN
});

// ==========================================
// 2. THE PROMPTS
// ==========================================
const EXTRACTOR_PROMPT = `You are a Surgical Data Extraction Agent. 
Analyze the following clinical trial text. Extract the PICO (Population, Intervention, Control, Outcomes), all statistical endpoints (with p-values and confidence intervals), and explicitly note any methodological limitations mentioned. 
Do not format for a UI. Just extract the raw facts accurately.`;

const ADJUDICATOR_PROMPT = `You are the Chief of Surgery and an expert in EBM (Evidence-Based Medicine).
You will receive a Source Text, followed by data extracted by two independent AI Registrars (Extractor A and Extractor B).
Your job is to compare their extractions against the Source Text. Resolve any discrepancies. 
If a data point is missing from the source text, strictly output 'null'. 
Apply GRADE methodology to assess evidence certainty (High/Moderate/Low/Very Low).
Recommend a chart type ('bar', 'stepped-line', or 'forest') for the endpoints.

You MUST return your final synthesis strictly as a JSON object matching this exact schema:
{
  "metadata": { "trial_identification": "String", "data_depth": "String" },
  "clinician_view": {
    "context": { "already_known": "String", "what_this_adds": "String" },
    "pico": { "population": "String", "intervention": "String", "control": "String", "primary_outcome": "String" },
    "critical_appraisal": { "grade_certainty": "String", "consort_limitations": "String" },
    "interactive_data": {
      "endpoints": [
        { "id": "String", "label": "String", "recommended_chart_type": "String", "clinical_synthesis": "String", "axes": {"x_label": "String", "y_label": "String"}, "arms": [ { "group_name": "String", "data_points": [ {"x": "String", "y": 0, "source_quote": "String"} ] } ] }
      ],
      "subgroups": []
    }
  },
  "patient_view": {
    "lay_condition_summary": "String", "lay_trial_results": "String", "why_it_matters": "String",
    "interactive_data": { "recommended_chart_type": "waffle", "natural_frequency_baseline": 100, "arms": [ {"group_name": "String", "bad_outcome_count_out_of_100": 0} ] }
  }
}`;

// ==========================================
// 3. THE PRE-FLIGHT ROUTER (PUBMED)
// ==========================================
async function fetchPubMedAbstract(pmid) {
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=text&rettype=abstract`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch abstract from PubMed.");
    return await response.text();
}

// ==========================================
// 4. THE MAIN API HANDLER
// ==========================================
export default async function handler(req, res) {
    // CORS configuration for Squarespace
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { inputPayload } = req.body;
        let textToAnalyze = inputPayload;
        let dataSource = "Raw Text";

        // Route: If the input is just 7-8 digits, fetch from PubMed
        if (/^\d{7,8}$/.test(inputPayload.trim())) {
            dataSource = `PubMed Abstract (PMID: ${inputPayload.trim()})`;
            textToAnalyze = await fetchPubMedAbstract(inputPayload.trim());
        }

        const sourceContext = `[SOURCE: ${dataSource}]\n\n${textToAnalyze}`;

        // ---------------------------------------------------------
        // NODE 1 & 2: PARALLEL EXTRACTION (The "Registrars")
        // ---------------------------------------------------------
        const [geminiResult, llamaResult] = await Promise.all([
            // Extractor A: Gemini 3.1 Pro
            gemini.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: `${EXTRACTOR_PROMPT}\n\n${sourceContext}`,
                config: { temperature: 0.1 }
            }).then(res => res.text()),

            // Extractor B: Llama 3.1 70B via GitHub Models
            githubAi.chat.completions.create({
                model: "Meta-Llama-3.1-70B-Instruct",
                messages: [
                    { role: "system", content: EXTRACTOR_PROMPT },
                    { role: "user", content: sourceContext }
                ],
                temperature: 0.1
            }).then(res => res.choices[0].message.content)
        ]);

        // ---------------------------------------------------------
        // NODE 3: THE ADJUDICATOR (The "Consultant")
        // ---------------------------------------------------------
        const adjudicationPrompt = `
        SOURCE TEXT:\n${sourceContext}\n\n
        ---
        EXTRACTOR A (Gemini) FOUND:\n${geminiResult}\n\n
        ---
        EXTRACTOR B (Llama) FOUND:\n${llamaResult}\n\n
        ---
        Perform your adjudication and output the final JSON payload.`;

        const finalResponse = await githubAi.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: ADJUDICATOR_PROMPT },
                { role: "user", content: adjudicationPrompt }
            ],
            response_format: { type: "json_object" }, // Forces strict JSON out of GPT-4o
            temperature: 0.0
        });

        // Parse and return the mathematically verified JSON to your website
        const jsonResult = JSON.parse(finalResponse.choices[0].message.content);
        return res.status(200).json(jsonResult);

    } catch (error) {
        console.error("Outcomelogic API Error:", error);
        return res.status(500).json({ error: "Failed to process the clinical text.", details: error.message });
    }
}