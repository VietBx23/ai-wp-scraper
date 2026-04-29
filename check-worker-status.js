require('dotenv').config();
const db = require('./db');

async function checkStatus() {
    try {
        console.log('=== AI Worker Status ===\n');

        // Check articles by status
        const [byStatus] = await db.query(`
            SELECT status, COUNT(*) as count
            FROM art_processed
            GROUP BY status
            ORDER BY count DESC
        `);

        console.log('📊 Articles by status:');
        byStatus.forEach(s => {
            console.log(`  ${s.status}: ${s.count}`);
        });

        // Check pending articles
        const [pending] = await db.query(`
            SELECT COUNT(*) as count
            FROM art_processed
            WHERE status = 'pending' AND website_id IS NOT NULL AND tier = 3
        `);
        console.log(`\n🔄 Pending articles (ready for AI): ${pending[0].count}`);

        // Check processing articles (might be stuck)
        const [processing] = await db.query(`
            SELECT id, language, created_at, TIMESTAMPDIFF(MINUTE, created_at, NOW()) as age_minutes
            FROM art_processed
            WHERE status = 'processing'
            ORDER BY created_at ASC
            LIMIT 10
        `);

        if (processing.length > 0) {
            console.log(`\n⚠️  Processing articles (${processing.length}):`);
            processing.forEach(p => {
                console.log(`  ID ${p.id} [${p.language}] - ${p.age_minutes} minutes old`);
            });
            if (processing.some(p => p.age_minutes > 30)) {
                console.log(`\n  💡 Some articles stuck > 30 min. Worker should auto-reset them.`);
            }
        } else {
            console.log(`\n✅ No stuck processing articles`);
        }

        // Check recent processed articles
        const [recent] = await db.query(`
            SELECT id, language, title_ai, created_at, updated_at
            FROM art_processed
            WHERE status = 'processed'
            ORDER BY updated_at DESC
            LIMIT 5
        `);

        if (recent.length > 0) {
            console.log(`\n✅ Recently processed (last 5):`);
            recent.forEach(a => {
                console.log(`  ${a.id}. [${a.language}] ${a.title_ai?.slice(0, 50)}`);
                console.log(`     Updated: ${a.updated_at}`);
            });
        }

        // Check AI errors
        const [errors] = await db.query(`
            SELECT COUNT(*) as count
            FROM art_processed
            WHERE status = 'ai_error'
        `);
        console.log(`\n❌ AI errors: ${errors[0].count}`);

        if (errors[0].count > 0) {
            const [errorSamples] = await db.query(`
                SELECT id, language, created_at
                FROM art_processed
                WHERE status = 'ai_error'
                ORDER BY created_at DESC
                LIMIT 5
            `);
            console.log(`   Recent errors:`);
            errorSamples.forEach(e => {
                console.log(`     ID ${e.id} [${e.language}] - ${e.created_at}`);
            });
        }

        // Check if worker is running (check recent activity)
        const [lastActivity] = await db.query(`
            SELECT MAX(updated_at) as last_update
            FROM art_processed
            WHERE status IN ('processed', 'processing')
        `);

        if (lastActivity[0].last_update) {
            const lastUpdate = new Date(lastActivity[0].last_update);
            const minutesAgo = Math.floor((Date.now() - lastUpdate) / 60000);
            console.log(`\n⏰ Last worker activity: ${minutesAgo} minutes ago`);
            if (minutesAgo > 30) {
                console.log(`   ⚠️  Worker might not be running! Last activity > 30 min ago.`);
            } else {
                console.log(`   ✅ Worker is active`);
            }
        } else {
            console.log(`\n⚠️  No worker activity detected`);
        }

        await db.end();
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}

checkStatus();
