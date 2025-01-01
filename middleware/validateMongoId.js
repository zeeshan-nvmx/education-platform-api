// middleware/validateMongoId.js
const mongoose = require('mongoose')
const { AppError } = require('../utils/errors')

module.exports = (req, res, next) => {
  const params = req.params

  for (let param in params) {
    if (param.toLowerCase().includes('id')) {
      if (!mongoose.Types.ObjectId.isValid(params[param])) {
        return next(new AppError(`Invalid ${param}`, 400))
      }
    }
  }

  next()
}
