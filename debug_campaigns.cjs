
const fs = require('fs');
const path = require('path');

const CAMPAIGNS_DIR = 'd:/Games/AI DM Project/Automated_system/mainApp/data/campaigns';

function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return fallback; }
}

const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f =>
    f.endsWith('.json') &&
    !f.includes('.state') &&
    !f.includes('.lore') &&
    !f.includes('.npcs') &&
    !f.includes('.archive') &&
    !f.includes('.index')
);

console.log('Files found:', files);

const campaigns = files
    .map(f => {
        const data = readJson(path.join(CAMPAIGNS_DIR, f));
        if (data && data.id && data.name) {
            return {
                id: data.id,
                name: data.name,
                lastPlayedAt: data.lastPlayedAt || 0
            };
        }
        return { file: f, status: 'filtered out' };
    });

console.log('Campaign objects:', JSON.stringify(campaigns, null, 2));
