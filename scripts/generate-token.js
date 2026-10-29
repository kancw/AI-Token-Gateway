require('dotenv').config();
const jwt = require('jsonwebtoken');

const secret = process.env.JWT_SECRET;
if (!secret) {
    console.error("❌ ERROR: JWT_SECRET is missing from your .env file!");
    process.exit(1);
}

// Configurable tier test payload (1, 2, or 3)
const tier = parseInt(process.argv[2], 10) || 3;
const userId = process.argv[3] || 'dev_user_001';

const payload = {
    user_id: userId,
    user_tier: tier
};

const token = jwt.sign(payload, secret, { expiresIn: '7d' });

console.log('==================================================');
console.log(`✅ TEST JWT GENERATED FOR TIER ${tier} (User: ${userId})`);
console.log('==================================================');
console.log('Bearer Token:');
console.log(token);
console.log('\nUse this token in your Authorization header or paste it into the UI settings.');
console.log('==================================================');
