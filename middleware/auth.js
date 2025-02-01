// const { verifyToken } = require('../utils/token')
// const { User } = require('../models')
// const { AppError } = require('../utils/errors')

// exports.protect = async (req, res, next) => {
//   try {
//     let token
//     if (req.headers.authorization?.startsWith('Bearer')) {
//       token = req.headers.authorization.split(' ')[1]
//     }

//     if (!token) {
//       return next(new AppError('Please log in to access this resource', 401))
//     }

//     const decoded = verifyToken(token)
//     const user = await User.findById(decoded.id)

//     if (!user) {
//       return next(new AppError('User no longer exists', 401))
//     }

//     req.user = user
//     next()
//   } catch (error) {
//     next(new AppError('Invalid token', 401))
//   }
// }

// exports.restrictTo = (...roles) => {
//   return (req, res, next) => {
//     if (!roles.includes(req.user.role)) {
//       return next(new AppError('You do not have permission to perform this action', 403))
//     }
//     next()
//   }
// }

// exports.isEmailVerified = (req, res, next) => {
//   if (!req.user.isEmailVerified) {
//     return next(new AppError('Please verify your email first', 403))
//   }
//   next()
// }


const { verifyToken } = require('../utils/token')
const { User } = require('../models')
const { AppError } = require('../utils/errors')

exports.protect = async (req, res, next) => {
  try {

    let token
    if (req.headers.authorization?.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1]
    }

    if (!token) {
      return next(new AppError('Please log in to access this resource', 401))
    }

    // Verify token
    const decoded = await verifyToken(token)

    // Find user with explicit field selection
    const user = await User.findById(decoded.id).select('+role +enrolledCourses').lean()

    if (!user) {
      return next(new AppError('User no longer exists', 401))
    }

    // Set default enrolledCourses if it doesn't exist
    user.enrolledCourses = user.enrolledCourses || []

    // console.log('Protect middleware - User found:', {
    //   userId: user._id,
    //   role: user.role,
    //   hasEnrolledCourses: Array.isArray(user.enrolledCourses),
    // })

    req.user = user
    next()
  } catch (error) {
    console.error('Protect middleware error:', error)
    return next(new AppError('Authentication failed', 401))
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