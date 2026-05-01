//#অটিজিনাল
/* mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CandleDataSchema = new Schema({
  symbol: {
    type: String,
    required: true,
    index: true
  },
  date: {
    type: String,
    required: true,
    index: true
  },
  open: { type: Number, default: null },
  close: { type: Number, default: null },
  high: { type: Number, default: null },
  low: { type: Number, default: null },
  volume: { type: Number, default: null },
  value: { type: Number, default: null },
  trades: { type: Number, default: null },
  change: { type: Number, default: null },
  marketCap: { type: Number, default: null },
  sector: { type: String, default: null }  // ✅ শুধু এই লাইনটি যোগ করা হয়েছে
},
            { upsert: true }                         );

// ✅ যুক্ত করো এই লাইন
CandleDataSchema.index({ symbol: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('CandleData', CandleDataSchema); */

//উপরের টা অরিজিনাল




//#অটিজিনাল
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CandleDataSchema = new Schema({
  symbol: {
    type: String,
    required: true,
    index: true
  },
  date: {
    type: String,
    required: true,
    index: true
  },
  open: { type: Number, default: null },
  close: { type: Number, default: null },
  high: { type: Number, default: null },
  low: { type: Number, default: null },
  volume: { type: Number, default: null },
  value: { type: Number, default: null },
  trades: { type: Number, default: null },
  change: { type: Number, default: null },
  marketCap: { type: Number, default: null },
  freeFloatMarketCap: { type: Number, default: null },  // ✅ NEW
  sector: { type: String, default: null }
},
            { upsert: true }                         );

// ✅ যুক্ত করো এই লাইন
CandleDataSchema.index({ symbol: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('CandleData', CandleDataSchema);





