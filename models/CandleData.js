const mongoose = require('mongoose');

const CandleDataSchema = new mongoose.Schema({
  symbol:  { type: String, required: true, index: true },
  date:    { type: String, required: true, index: true },

  // Price
  open:    { type: Number, default: null },
  close:   { type: Number, default: null },
  high:    { type: Number, default: null },
  low:     { type: Number, default: null },
  ycp:     { type: Number, default: null },   // ⚡ নতুন
  change:  { type: Number, default: null },

  // Volume / value
  volume:  { type: Number, default: null },
  value:   { type: Number, default: null },
  trades:  { type: Number, default: null },

  // Company info
  sector:             { type: String, default: null },
  marketCap:          { type: Number, default: null },
  freeFloatMarketCap: { type: Number, default: null },

  // Meta
  savedAt: { type: Date, default: Date.now },
});

// Compound unique index — একই দিনে একই symbol duplicate হবে না
CandleDataSchema.index({ symbol: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('CandleData', CandleDataSchema);