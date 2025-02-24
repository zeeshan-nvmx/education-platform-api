const bcrypt = require('bcryptjs')
const Joi = require('joi')
const { User } = require('../models')
const { AppError } = require('../utils/errors')
const { generateToken } = require('../utils/token')
const { sendVerificationOtp, sendPasswordResetOtp } = require('../utils/email')

const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/

const signupSchema = Joi.object({
  firstName: Joi.string().min(2).max(50).required(),
  lastName: Joi.string().min(2).max(50).required(),
  email: Joi.string().email().required(),
  password: Joi.string().pattern(passwordRegex).required(),
  confirmPassword: Joi.string().valid(Joi.ref('password')).required(),
}).options({ abortEarly: false })

const verifyEmailSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string()
    .length(6)
    .pattern(/^[0-9A-Z]+$/)
    .required(),
}).options({ abortEarly: false })

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
}).options({ abortEarly: false })

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
}).options({ abortEarly: false })

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string()
    .length(6)
    .pattern(/^[0-9A-Z]+$/)
    .required(),
  password: Joi.string().pattern(passwordRegex).required(),
  confirmPassword: Joi.string().valid(Joi.ref('password')).required(),
}).options({ abortEarly: false })

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().pattern(passwordRegex).required(),
  confirmNewPassword: Joi.string().valid(Joi.ref('newPassword')).required(),
}).options({ abortEarly: false })

const formatValidationErrors = (error) => {
  if (!error || !error.details) return 'Validation failed'
  return error.details.map((detail) => detail.message).join(', ')
}

const generateOTP = () => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let otp = ''
  for (let i = 0; i < 6; i++) {
    otp += chars[Math.floor(Math.random() * chars.length)]
  }
  return otp
}

exports.signup = async (req, res, next) => {
  try {
    const { error, value } = signupSchema.validate(req.body)
    if (error) {
      return next(new AppError(formatValidationErrors(error), 400))
    }

    const { firstName, lastName, email, password } = value

    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return next(new AppError('Email already registered', 400))
    }

    const verificationToken = generateOTP()

    const user = await User.create({
      firstName,
      lastName,
      email,
      password,
      verificationToken,
    })

    const token = generateToken({ id: user._id })

    const userData = {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
    }

    res.status(201).json({
      message: 'Registration successful. Please verify your email with the sent otp.',
      token,
      data: userData,
    })
  } catch (error) {
    next(error)
  }
}

exports.verifyEmail = async (req, res, next) => {
  try {
    const { error, value } = verifyEmailSchema.validate(req.body)
    if (error) {
      return next(new AppError(formatValidationErrors(error), 400))
    }

    const { email, otp } = value

    const user = await User.findOne({
      email,
      verificationToken: otp,
    })

    if (!user) {
      return next(new AppError('Invalid verification code', 400))
    }

    user.isEmailVerified = true
    user.verificationToken = undefined
    await user.save()

    res.status(200).json({
      message: 'Email verified successfully',
    })
  } catch (error) {
    next(error)
  }
}

exports.login = async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body)
    if (error) {
      return next(new AppError(formatValidationErrors(error), 400))
    }

    const { email, password } = value

    const user = await User.findOne({ email }).select('+password')
    if (!user) {
      return next(new AppError('Invalid email or password', 401))
    }

    const isPasswordValid = await bcrypt.compare(password, user.password)
    if (!isPasswordValid) {
      return next(new AppError('Invalid email or password', 401))
    }

    const token = generateToken({ id: user._id })

    const userData = {
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      enrolledCourses: user.enrolledCourses,
    }

    res.status(200).json({
      message: 'Login successful',
      token,
      data: userData,
    })
  } catch (error) {
    next(error)
  }
}

exports.forgotPassword = async (req, res, next) => {
  try {
    const { error, value } = forgotPasswordSchema.validate(req.body)
    if (error) {
      return next(new AppError(formatValidationErrors(error), 400))
    }

    const { email } = value

    const user = await User.findOne({ email })
    if (!user) {
      return next(new AppError('User not found', 404))
    }

    const resetToken = generateOTP()
    user.resetPasswordToken = resetToken
    user.resetPasswordExpires = Date.now() + parseInt(process.env.PASSWORD_RESET_TOKEN_EXPIRES_IN)
    await user.save()

    try {
      await sendPasswordResetOtp(email, resetToken)

      res.status(200).json({
        message: 'Password reset code sent to email',
      })
    } catch (error) {
      user.resetPasswordToken = undefined
      user.resetPasswordExpires = undefined
      await user.save()

      return next(new AppError('Error sending password reset code. Please try again later.', 500))
    }
  } catch (error) {
    next(error)
  }
}

exports.resetPassword = async (req, res, next) => {
  try {
    const { error, value } = resetPasswordSchema.validate(req.body)
    if (error) {
      return next(new AppError(formatValidationErrors(error), 400))
    }

    const { email, otp, password } = value

    const user = await User.findOne({
      email,
      resetPasswordToken: otp,
      resetPasswordExpires: { $gt: Date.now() },
    })

    if (!user) {
      return next(new AppError('Invalid or expired reset code', 400))
    }

    user.password = password
    user.resetPasswordToken = undefined
    user.resetPasswordExpires = undefined
    await user.save()

    res.status(200).json({
      message: 'Password reset successful',
    })
  } catch (error) {
    next(error)
  }
}

exports.changePassword = async (req, res, next) => {
  try {
    const { error, value } = changePasswordSchema.validate(req.body)
    if (error) {
      return next(new AppError(formatValidationErrors(error), 400))
    }

    const { currentPassword, newPassword } = value

    const user = await User.findById(req.user._id).select('+password')

    const isPasswordValid = await bcrypt.compare(currentPassword, user.password)
    if (!isPasswordValid) {
      return next(new AppError('Current password is incorrect', 401))
    }

    user.password = newPassword
    await user.save()

    res.status(200).json({
      message: 'Password changed successfully',
    })
  } catch (error) {
    next(error)
  }
}

// const bcrypt = require('bcryptjs')
// const Joi = require('joi')
// const { User } = require('../models')
// const { AppError } = require('../utils/errors')
// const { generateToken } = require('../utils/token')
// const { sendVerificationOtp, sendPasswordResetOtp } = require('../utils/email')

// // Validation schemas
// const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/

// const signupSchema = Joi.object({
//   firstName: Joi.string().min(2).max(50).required().messages({
//     'string.min': 'First name must be at least 2 characters long',
//     'string.max': 'First name cannot exceed 50 characters',
//     'any.required': 'First name is required',
//   }),
//   lastName: Joi.string().min(2).max(50).required().messages({
//     'string.min': 'Last name must be at least 2 characters long',
//     'string.max': 'Last name cannot exceed 50 characters',
//     'any.required': 'Last name is required',
//   }),
//   email: Joi.string().email().required().messages({
//     'string.email': 'Please provide a valid email address',
//     'any.required': 'Email is required',
//   }),
//   password: Joi.string().pattern(passwordRegex).required().messages({
//     'string.pattern.base': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character',
//     'any.required': 'Password is required',
//   }),
//   confirmPassword: Joi.string().valid(Joi.ref('password')).required().messages({
//     'any.only': 'Passwords do not match',
//     'any.required': 'Please confirm your password',
//   }),
// }).options({ abortEarly: false })

// const verifyEmailSchema = Joi.object({
//   email: Joi.string().email().required().messages({
//     'string.email': 'Please provide a valid email address',
//     'any.required': 'Email is required',
//   }),
//   otp: Joi.string()
//     .length(6)
//     .pattern(/^[0-9A-Z]+$/)
//     .required()
//     .messages({
//       'string.length': 'OTP must be 6 characters long',
//       'string.pattern.base': 'OTP must contain only numbers and uppercase letters',
//       'any.required': 'OTP is required',
//     }),
// }).options({ abortEarly: false })

// const loginSchema = Joi.object({
//   email: Joi.string().email().required().messages({
//     'string.email': 'Please provide a valid email address',
//     'any.required': 'Email is required',
//   }),
//   password: Joi.string().required().messages({
//     'any.required': 'Password is required',
//   }),
// }).options({ abortEarly: false })

// const forgotPasswordSchema = Joi.object({
//   email: Joi.string().email().required().messages({
//     'string.email': 'Please provide a valid email address',
//     'any.required': 'Email is required',
//   }),
// }).options({ abortEarly: false })

// const resetPasswordSchema = Joi.object({
//   email: Joi.string().email().required().messages({
//     'string.email': 'Please provide a valid email address',
//     'any.required': 'Email is required',
//   }),
//   otp: Joi.string()
//     .length(6)
//     .pattern(/^[0-9A-Z]+$/)
//     .required()
//     .messages({
//       'string.length': 'OTP must be 6 characters long',
//       'string.pattern.base': 'OTP must contain only numbers and uppercase letters',
//       'any.required': 'OTP is required',
//     }),
//   password: Joi.string().pattern(passwordRegex).required().messages({
//     'string.pattern.base': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character',
//     'any.required': 'Password is required',
//   }),
//   confirmPassword: Joi.string().valid(Joi.ref('password')).required().messages({
//     'any.only': 'Passwords do not match',
//     'any.required': 'Please confirm your password',
//   }),
// }).options({ abortEarly: false })

// const changePasswordSchema = Joi.object({
//   currentPassword: Joi.string().required().messages({
//     'any.required': 'Current password is required',
//   }),
//   newPassword: Joi.string().pattern(passwordRegex).required().messages({
//     'string.pattern.base': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character',
//     'any.required': 'New password is required',
//   }),
//   confirmNewPassword: Joi.string().valid(Joi.ref('newPassword')).required().messages({
//     'any.only': 'Passwords do not match',
//     'any.required': 'Please confirm your new password',
//   }),
// }).options({ abortEarly: false })

// // Helper function to generate OTP
// const generateOTP = () => {
//   const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
//   let otp = ''
//   for (let i = 0; i < 6; i++) {
//     otp += chars[Math.floor(Math.random() * chars.length)]
//   }
//   return otp
// }

// exports.signup = async (req, res, next) => {
//   try {
//     const { error, value } = signupSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const { firstName, lastName, email, password } = value

//     const existingUser = await User.findOne({ email })
//     if (existingUser) {
//       return next(new AppError('Email already registered', 400))
//     }

//     const verificationToken = generateOTP()

//     const user = await User.create({
//       firstName,
//       lastName,
//       email,
//       password,
//       verificationToken,
//     })

//     // await sendVerificationOtp(email, verificationToken)

//     const token = generateToken({ id: user._id })

//     // Exclude sensitive fields from response
//     const userData = {
//       _id: user._id,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       email: user.email,
//       role: user.role,
//       isEmailVerified: user.isEmailVerified,
//     }

//     res.status(201).json({
//       message: 'Registration successful. Please verify your email with the sent otp.',
//       token,
//       data: userData,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.verifyEmail = async (req, res, next) => {
//   try {
//     const { error, value } = verifyEmailSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const { email, otp } = value

//     const user = await User.findOne({
//       email,
//       verificationToken: otp,
//     })

//     if (!user) {
//       return next(new AppError('Invalid verification code', 400))
//     }

//     user.isEmailVerified = true
//     user.verificationToken = undefined
//     await user.save()

//     res.status(200).json({
//       message: 'Email verified successfully',
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.login = async (req, res, next) => {
//   try {
//     const { error, value } = loginSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const { email, password } = value

//     const user = await User.findOne({ email }).select('+password')
//     if (!user) {
//       return next(new AppError('Invalid email or password', 401))
//     }

//     const isPasswordValid = await bcrypt.compare(password, user.password)
//     if (!isPasswordValid) {
//       return next(new AppError('Invalid email or password', 401))
//     }

//     const token = generateToken({ id: user._id })

//     // Exclude sensitive fields from response
//     const userData = {
//       _id: user._id,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       role: user.role,
//       email: user.email,
//       isEmailVerified: user.isEmailVerified,
//       enrolledCourses: user.enrolledCourses,
//     }

//     res.status(200).json({
//       message: 'Login successful',
//       token,
//       data: userData,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.forgotPassword = async (req, res, next) => {
//   try {
//     const { error, value } = forgotPasswordSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const { email } = value

//     const user = await User.findOne({ email })
//     if (!user) {
//       return next(new AppError('User not found', 404))
//     }

//     const resetToken = generateOTP()
//     user.resetPasswordToken = resetToken
//     user.resetPasswordExpires = Date.now() + parseInt(process.env.PASSWORD_RESET_TOKEN_EXPIRES_IN)
//     await user.save()

//     try {
//       await sendPasswordResetOtp(email, resetToken)

//       res.status(200).json({
//         message: 'Password reset code sent to email',
//       })
//     } catch (error) {
//       user.resetPasswordToken = undefined
//       user.resetPasswordExpires = undefined
//       await user.save()

//       return next(new AppError('Error sending password reset code. Please try again later.', 500))
//     }
//   } catch (error) {
//     next(error)
//   }
// }

// exports.resetPassword = async (req, res, next) => {
//   try {
//     const { error, value } = resetPasswordSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const { email, otp, password } = value

//     const user = await User.findOne({
//       email,
//       resetPasswordToken: otp,
//       resetPasswordExpires: { $gt: Date.now() },
//     })

//     if (!user) {
//       return next(new AppError('Invalid or expired reset code', 400))
//     }

//     user.password = password
//     user.resetPasswordToken = undefined
//     user.resetPasswordExpires = undefined
//     await user.save()

//     res.status(200).json({
//       message: 'Password reset successful',
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.changePassword = async (req, res, next) => {
//   try {
//     const { error, value } = changePasswordSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const { currentPassword, newPassword } = value

//     const user = await User.findById(req.user._id).select('+password')

//     const isPasswordValid = await bcrypt.compare(currentPassword, user.password)
//     if (!isPasswordValid) {
//       return next(new AppError('Current password is incorrect', 401))
//     }

//     user.password = newPassword
//     await user.save()

//     res.status(200).json({
//       message: 'Password changed successfully',
//     })
//   } catch (error) {
//     next(error)
//   }
// }
