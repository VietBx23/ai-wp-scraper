/**
 * Script kiểm tra sites trong database
 */
require('dotenv').config();
const db = require('./db');

async function checkSites() {
    try {
        console.log('=== Checking Sites Configuration ===\n');

        // Check all sites
        const [allSites] = await db.query(`
            SELECT id, site_name, domain, status, level, language, type_id
            FROM site_main
            ORDER BY level, id
        `);
        console.log(`📊 Total sites: ${allSites.length}`);
        allSites.forEach(s => {
            console.log(`  ${s.id}. ${s.site_name} (${s.domain})`);
            console.log(`     Status: ${s.status} | Tier: ${s.level} | Lang: ${s.language} | Type: ${s.type_id || 'NULL'}`);
        });

        // Check active Tier 3 sites
        const [tier3Sites] = await db.query(`
            SELECT id, site_name, domain, language, type_id, status
            FROM site_main
            WHERE status = 'active' AND level = 3
        `);
        console.log(`\n✅ Active Tier 3 sites: ${tier3Sites.length}`);
        tier3Sites.forEach(s => {
            console.log(`  ${s.id}. ${s.site_name} - ${s.language} (type_id: ${s.type_id || 'NULL'})`);
        });

        // Check topics
        const [topics] = await db.query(`
            SELECT id, name, is_active FROM site_tags ORDER BY id
        `);
        console.log(`\n📌 Topics: ${topics.length}`);
        topics.forEach(t => {
            console.log(`  ${t.id}. ${t.name} (${t.is_active ? 'active' : 'inactive'})`);
        });

        // Check site types
        const [siteTypes] = await db.query(`
            SELECT id, name, is_active FROM site_types ORDER BY id
        `);
        console.log(`\n🏷️  Site Types: ${siteTypes.length}`);
        siteTypes.forEach(st => {
            console.log(`  ${st.id}. ${st.name} (${st.is_active ? 'active' : 'inactive'})`);
        });

        // Check site_topics mapping
        const [siteTopics] = await db.query(`
            SELECT st.website_id, sm.site_name, st.topic_id, t.name as topic_name
            FROM site_topics st
            JOIN site_main sm ON sm.id = st.website_id
            JOIN site_tags t ON t.id = st.topic_id
            WHERE sm.status = 'active' AND sm.level = 3
            ORDER BY st.website_id, st.topic_id
        `);
        console.log(`\n🔗 Site-Topic Mappings (Tier 3 Active): ${siteTopics.length}`);
        const grouped = {};
        siteTopics.forEach(st => {
            if (!grouped[st.website_id]) grouped[st.website_id] = { name: st.site_name, topics: [] };
            grouped[st.website_id].topics.push(st.topic_name);
        });
        Object.entries(grouped).forEach(([id, data]) => {
            console.log(`  Site ${id} (${data.name}): ${data.topics.join(', ')}`);
        });

        // Check if any Tier 3 sites have NO topics assigned
        const [sitesWithoutTopics] = await db.query(`
            SELECT sm.id, sm.site_name, sm.type_id
            FROM site_main sm
            LEFT JOIN site_topics st ON st.website_id = sm.id
            WHERE sm.status = 'active' AND sm.level = 3 AND st.id IS NULL
        `);
        if (sitesWithoutTopics.length > 0) {
            console.log(`\n⚠️  Tier 3 sites WITHOUT topics assigned: ${sitesWithoutTopics.length}`);
            sitesWithoutTopics.forEach(s => {
                console.log(`  ${s.id}. ${s.site_name} (type_id: ${s.type_id || 'NULL'})`);
            });
        }

        console.log('\n=== Summary ===');
        console.log(`Total sites: ${allSites.length}`);
        console.log(`Active Tier 3: ${tier3Sites.length}`);
        console.log(`Topics: ${topics.filter(t => t.is_active).length} active`);
        console.log(`Site Types: ${siteTypes.filter(st => st.is_active).length} active`);
        console.log(`Site-Topic mappings: ${siteTopics.length}`);
        
        if (tier3Sites.length === 0) {
            console.log('\n❌ PROBLEM: No active Tier 3 sites found!');
            console.log('   Solution: Add sites with level=3 and status=\'active\'');
        }
        if (sitesWithoutTopics.length > 0) {
            console.log('\n⚠️  WARNING: Some Tier 3 sites have no topics assigned');
            console.log('   They will match ALL topics by default');
        }

        await db.end();
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}

checkSites();
