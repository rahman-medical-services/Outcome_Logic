// api/search.js

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

    try {
        const { query } = req.body;
        if (!query) return res.status(400).json({ error: "Missing search query." });

        // Query Europe PMC for the top 10 results
        const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&resultType=core&format=json&pageSize=10`;
        const response = await fetch(url);
        
        if (!response.ok) throw new Error("Failed to contact Europe PMC.");
        const data = await response.json();

        if (!data.resultList || !data.resultList.result || data.resultList.result.length === 0) {
            return res.status(200).json({ results: [] });
        }

        // Map the raw data into a clean list for your UI
        const formattedResults = data.resultList.result.map(trial => {
            const hasFreeFullText = trial.pmcid || trial.isOpenAccess === 'Y';
            return {
                id: trial.pmid || trial.id,
                title: trial.title,
                authors: trial.authorString ? trial.authorString.split(',').slice(0, 3).join(', ') + ' et al.' : 'Unknown Authors',
                journal: trial.journalTitle || 'Unknown Journal',
                year: trial.pubYear,
                has_free_full_text: !!hasFreeFullText
            };
        });

        return res.status(200).json({ results: formattedResults });

    } catch (error) {
        console.error("Search API Error:", error);
        return res.status(500).json({ error: "Search failed.", details: error.message });
    }
}