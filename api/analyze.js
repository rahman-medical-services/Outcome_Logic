import OpenAI from 'openai';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

// ==========================================
// 1. INITIALIZE THE GITHUB MODELS CLIENT
// ==========================================
const githubAi = new OpenAI({
    baseURL: "https://models.inference.ai.azure.com",
    apiKey: process.env.GITHUB_TOKEN
});

// ==========================================
// 2. THE PROMPTS
// ==========================================
const EXTRACTOR_PROMPT = `You are a Surgical Data Extraction Agent analyzing a FULL-TEXT clinical trial. 
Extract the PICO (Population, Intervention, Control, Outcomes), all statistical endpoints (with p-values and confidence intervals), subgroup analyses, and explicitly note any methodological limitations mentioned in the Discussion/Limitations section. 
Do not format for a UI. Just extract the raw facts accurately.`;

const ADJUDICATOR_PROMPT = `You are the Chief of Surgery and an expert in EBM (Evidence-Based Medicine).
You will receive a Source Text, followed by data extracted by two independent AI Registrars.
Your job is to compare their extractions against the Source Text. Resolve any discrepancies. 
If a data point is missing from the source text, strictly output 'null'. 
Apply GRADE methodology to assess evidence certainty. Recommend a chart type ('bar', 'stepped-line', or 'forest') for the endpoints.

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
// 3. ROUTERS (Europe PMC, URL, and PDF)
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
    // Convert Base64 string back to binary buffer for the PDF parser
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    const data = await pdfParse(pdfBuffer);
    return data.text;
}

// ==========================================
// 4. THE MAIN API HANDLER
// ==========================================
export default async function handler(req, res) {
    // Note: Vercel allows up to 4.5MB payloads, plenty for a medical PDF
    export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

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

        // THE NEW UNIVERSAL ROUTER
        if (isPdf) {
            // 1. It's a PDF file upload
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

        // Safeguard: Truncate text if it somehow exceeds 100k characters (unlikely for 1 paper)
        if (textToAnalyze.length > 100000) textToAnalyze = textToAnalyze.substring(0, 100000);

        const sourceContext = `[SOURCE: ${dataSource}]\n\n${textToAnalyze}`;

        // ---------------------------------------------------------
        // NODE 1 & 2: PARALLEL EXTRACTION 
        // ---------------------------------------------------------
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

        // ---------------------------------------------------------
        // NODE 3: THE ADJUDICATOR
        // ---------------------------------------------------------
        const adjudicationPrompt = `
        SOURCE TEXT:\n${sourceContext}\n\n
        ---
        EXTRACTOR A FOUND:\n${extractorAResult}\n\n
        ---
        EXTRACTOR B FOUND:\n${extractorBResult}\n\n
        ---
        Perform your adjudication and output the final JSON payload.`;

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