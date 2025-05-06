const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CandleDataSchema = new Schema({
  // 📌 কোম্পানি সিম্বল (যেমন: RECKITTBEN)
  symbol: {
    type: String,
    required: true,
    index: true // দ্রুত কোয়েরির জন্য ইনডেক্স
  },

  // 📅 মার্কেটের ডেটা তারিখ (যেমন: "2025-04-05")
  date: {
    type: String, // যদি আপনি তারিখটি `YYYY-MM-DD` ফরম্যাটে রাখতে চান
    required: true,
    index: true // দ্রুত হিস্টোরিক্যাল কোয়েরির জন্য ইনডেক্স
  },

  // 💹 ওপেনিং প্রাইস (যেমন: 3494.80)
  open: {
    type: Number,
    default: null // ভুল/অনুপস্থিত ডেটা চেকের জন্য
  },

  // 💹 লাস্ট ট্রেডিং প্রাইস (LTP)
  close: {
    type: Number,
    default: null
  },

  // 💹 দৈনিক উচ্চতম মূল্য
  high: {
    type: Number,
    default: null
  },

  // 💹 দৈনিক নিম্নতম মূল্য
  low: {
    type: Number,
    default: null
  },

  // 📊 টুডের ট্রেড ভলিউম (যেমন: 4725000)
  volume: {
    type: Number,
    default: null
  },

  // 💰 দৈনিক মার্কেট ভ্যালু (মিলিয়নে) (যেমন: 100000000)
  value: {
    type: Number,
    default: null
  },

  // 📈 টুডের ট্রেড সংখ্যা (যেমন: 1200)
  trades: {
    type: Number,
    default: null
  },

  // 💹 মূল্য পরিবর্তন (যেমন: -183.9)
  change: {
    type: Number,
    default: null
  },

  // 💰 মার্কেট ক্যাপিটালাইজেশন (মিলিয়নে) (যেমন: 1145600000)
  marketCap: {
    type: Number,
    default: null
  },

  // 📆 ডেটা কখন সংগ্রহ হয়েছে (যেমন: ISO 8601)
  collectedAt: {
    type: Date,
    default: Date.now // ডিফল্ট মান হিসেবে বর্তমান সময়
  }
});

// 📁 মডেল এক্সপোর্ট
module.exports = mongoose.model('CandleData', CandleDataSchema);