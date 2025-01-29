const parseFormDataJSON = (req, res, next) => {
  try {
    Object.keys(req.body).forEach((key) => {
      if (typeof req.body[key] === 'string') {
        try {
          const parsed = JSON.parse(req.body[key])
          if (typeof parsed === 'object' || Array.isArray(parsed)) {
            req.body[key] = parsed // Only assign if valid object/array
          }
        } catch (error) {
          // Ignore parsing errors for non-JSON strings
        }
      }
    })
  } catch (error) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid JSON format in form-data fields',
    })
  }
  next()
}

// // Apply this middleware globally before validation
// app.use(parseFormDataJSON)

module.exports = parseFormDataJSON
