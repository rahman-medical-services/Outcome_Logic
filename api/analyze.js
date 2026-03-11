import OpenAI from 'openai';

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
// 3. THE UNIVERSAL PRE-FLIGHT ROUTER
// ==========================================
async function fetchTrialData(query, isPmid = false) {
    // If it's a PMID, search by ID. Otherwise, do a general keyword/acronym search.
    const searchQuery = isPmid ? `ext_id:${query}` : query;
    const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(searchQuery)}&resultType=core&format=json`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch data from Europe PMC.");
    const data = await response.json();
    
    if (!data.resultList || !data.resultList.result || data.resultList.result.length === 0) {
        return "Error: No trial data found.";
    }
    
    // Grab the most relevant top result
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

// ==========================================
// 4. THE MAIN API HANDLER
// ==========================================
export default async function handler(req, res) {
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
        const inputTrimmed = inputPayload.trim();

        // THE UNIVERSAL ROUTING LOGIC
        if (/^\d{7,8}$/.test(inputTrimmed)) {
            // 1. It's a PMID
            dataSource = `EuropePMC (PMID: ${inputTrimmed})`;
            textToAnalyze = await fetchTrialData(inputTrimmed, true);
        } else if (inputTrimmed.startsWith('http://') || inputTrimmed.startsWith('https://')) {
            // 2. It's a URL
            dataSource = `Web Extraction (${inputTrimmed})`;
            textToAnalyze = await fetchFromUrl(inputTrimmed);
        } else if (inputTrimmed.length < 150) {
            // 3. It's a short string (Acronym or Title Search)
            dataSource = `EuropePMC Search (${inputTrimmed})`;
            textToAnalyze = await fetchTrialData(inputTrimmed, false);
        } else {
            // 4. It's long pasted text
            dataSource = "Pasted Raw Text";
            textToAnalyze = inputTrimmed;
        }

        const sourceContext = `[SOURCE: ${dataSource}]\n\n${textToAnalyze}`;

        // ... (Keep the rest of your NODE 1, 2, and 3 AI code exactly the same below here)


    // ---------------------------------------------------------
        // NODE 1 & 2: PARALLEL EXTRACTION (The "Registrars")
        // ---------------------------------------------------------
        const [extractorAResult, extractorBResult] = await Promise.all([
            // Extractor A: GPT-4o-mini
            githubAi.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: EXTRACTOR_PROMPT },
                    { role: "user", content: sourceContext }
                ],
                temperature: 0.1
            }).then(res => res.choices[0].message.content),

            // Extractor B: GPT-4o-mini (Acting as second independent reviewer)
            githubAi.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: EXTRACTOR_PROMPT },
                    { role: "user", content: sourceContext }
                ],
                temperature: 0.2 // Slightly higher temperature for independent variance
            }).then(res => res.choices[0].message.content)
        ]);

        // ---------------------------------------------------------
        // NODE 3: THE ADJUDICATOR (The "Consultant")
        // ---------------------------------------------------------
        const adjudicationPrompt = `
        SOURCE TEXT:\n${sourceContext}\n\n
        ---
        EXTRACTOR A (GPT-4o-mini) FOUND:\n${extractorAResult}\n\n
        ---
        EXTRACTOR B (Llama 3.1) FOUND:\n${extractorBResult}\n\n
        ---
        Perform your adjudication and output the final JSON payload.`;

        const finalResponse = await githubAi.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: ADJUDICATOR_PROMPT },
                { role: "user", content: adjudicationPrompt }
            ],
            response_format: { type: "json_object" }, 
            temperature: 0.0
        });

        const jsonResult = JSON.parse(finalResponse.choices[0].message.content);
        return res.status(200).json(jsonResult);

    } catch (error) {
        console.error("Outcomelogic API Error:", error);
        return res.status(500).json({ error: "Failed to process the clinical text.", details: error.message });
    }
}