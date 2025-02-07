const { verifyToken } = require('../utils/token')
const { User } = require('../models')
const { AppError } = require('../utils/errors')

// exports.protect = async (req, res, next) => {
//   try {

//     let token
//     if (req.headers.authorization?.startsWith('Bearer')) {
//       token = req.headers.authorization.split(' ')[1]
//     }

//     if (!token) {
//       return next(new AppError('Please log in to access this resource', 401))
//     }

//     // Verify token
//     const decoded = await verifyToken(token)

//     // Find user with explicit field selection
//     const user = await User.findById(decoded.id).select('+role +enrolledCourses').lean()

//     if (!user) {
//       return next(new AppError('User no longer exists', 401))
//     }

//     // Set default enrolledCourses if it doesn't exist
//     user.enrolledCourses = user.enrolledCourses || []

//     // console.log('Protect middleware - User found:', {
//     //   userId: user._id,
//     //   role: user.role,
//     //   hasEnrolledCourses: Array.isArray(user.enrolledCourses),
//     // })

//     req.user = user
//     next()
//   } catch (error) {
//     console.error('Protect middleware error:', error)
//     return next(new AppError('Authentication failed', 401))
//   }
// }

exports.protect = async (req, res, next) => {
  try {
    let token
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1]
    }

    if (!token) {
      return next(new AppError('Please log in to access this resource', 401))
    }

    const decoded = await verifyToken(token)

    try {
      const user = await User.findById(decoded.id).select('+role +enrolledCourses').lean().maxTimeMS(20000) // Add timeout

      if (!user) {
        return next(new AppError('User no longer exists', 401))
      }

      user.enrolledCourses = user.enrolledCourses || []
      req.user = user
      next()
    } catch (dbError) {
      console.error('Database query error:', dbError)
      return next(new AppError('Database query failed', 500))
    }
  } catch (error) {
    console.error('Protect middleware error:', error)
    return next(new AppError('Authentication failed', 401))
  }
}

// exports.optionalAuth = async (req, res, next) => {
//   try {
//     let token
//     if (req.headers.authorization?.startsWith('Bearer')) {
//       token = req.headers.authorization.split(' ')[1]
//     }

//     // If no token, continue as public user
//     if (!token) {
//       return next()
//     }

//     try {
//       // Verify token
//       const decoded = await verifyToken(token)

//       // Find user with explicit field selection
//       const user = await User.findById(decoded.id).select('+role +enrolledCourses').lean().maxTimeMS(20000)

//       if (user) {
//         // Set default enrolledCourses if it doesn't exist
//         user.enrolledCourses = user.enrolledCourses || []
//         req.user = user
//       }
//     } catch (error) {
//       // If token verification fails, continue as public user
//       console.log('Optional auth token verification failed:', error.message)
//     }

//     next()
//   } catch (error) {
//     console.error('Optional auth middleware error:', error)
//     next(error)
//   }
// }

exports.optionalAuth = async (req, res, next) => {
  try {
    let token
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1]
    }

    // If no token, continue as public user
    if (!token) {
      return next()
    }

    // Verify token
    const decoded = await verifyToken(token)

    // Attach the user ID and role
    req.user = {
      _id: decoded.id,
      role: decoded.role, 
    }

    next()
  } catch (error) {
    // If token verification fails, continue as public user (no error thrown)
    console.log('Optional auth token verification failed:', error.message)
    next() // Continue to the route handler, but req.user will be undefined
  }
}

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    console.log('RestrictTo middleware - User role:', req.user?.role)

    if (!req.user || !req.user.role) {
      return next(new AppError('Authentication required', 401))
    }

    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403))
    }
    next()
  }
}

exports.isEmailVerified = (req, res, next) => {
  // Check if user exists
  if (!req.user) {
    return next(new AppError('Authentication required', 401))
  }

  if (!req.user.isEmailVerified) {
    return next(new AppError('Please verify your email first', 403))
  }
  next()
}