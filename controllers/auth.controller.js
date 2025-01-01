const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const { User } = require('../models')
const { AppError } = require('../utils/errors')
const { generateToken } = require('../utils/token')
const { sendVerificationOtp, sendPasswordResetOtp } = require('../utils/email')
const { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, changePasswordSchema } = require('../validations/auth.validation')

// Helper function to generate 6-character alphanumeric OTP
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
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const { email, password } = value

    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return next(new AppError('Email already registered', 400))
    }

    // Generate OTP 
    const verificationToken = generateOTP()

    const user = await User.create({
      email,
      password,
      verificationToken, // Using existing verificationToken field for OTP
    })

    // Send verification OTP
    await sendVerificationOtp(email, verificationToken)

    const token = generateToken({ id: user._id })

    res.status(201).json({
      status: 'success',
      message: 'Registration successful. Please verify your email with the OTP sent.',
      token,
    })
  } catch (error) {
    next(error)
  }
}

exports.verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body

    const user = await User.findOne({
      email,
      verificationToken: otp, // Using existing verificationToken field
    })

    if (!user) {
      return next(new AppError('Invalid verification code', 400))
    }

    user.isEmailVerified = true
    user.verificationToken = undefined
    await user.save()

    res.status(200).json({
      status: 'success',
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
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
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
    user.password = undefined

    res.status(200).json({
      status: 'success',
      token,
      user,
    })
  } catch (error) {
    next(error)
  }
}

exports.forgotPassword = async (req, res, next) => {
  try {
    const { error, value } = forgotPasswordSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const { email } = value

    const user = await User.findOne({ email })
    if (!user) {
      return next(new AppError('User not found', 404))
    }

    // Generate OTP instead of reset token
    const resetToken = generateOTP()
    user.resetPasswordToken = resetToken // Using existing resetPasswordToken field
    user.resetPasswordExpires = Date.now() + parseInt(process.env.PASSWORD_RESET_TOKEN_EXPIRES_IN)
    await user.save()

    try {
      await sendPasswordResetOtp(email, resetToken)

      res.status(200).json({
        status: 'success',
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
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
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
      status: 'success',
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
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
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
      status: 'success',
      message: 'Password changed successfully',
    })
  } catch (error) {
    next(error)
  }
}

// const bcrypt = require('bcryptjs')
// const crypto = require('crypto')
// const { User } = require('../models')
// const { AppError } = require('../utils/errors')
// const { generateToken } = require('../utils/token')
// const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email')
// const { generateRandomToken } = require('../utils/crypto')
// const { signupSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, changePasswordSchema } = require('../validations/auth.validation')

// exports.signup = async (req, res, next) => {
//   try {
//     // Validate input
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

//     const { email, password } = value

//     // Check if user exists
//     const existingUser = await User.findOne({ email })
//     if (existingUser) {
//       return next(new AppError('Email already registered', 400))
//     }

//     // Generate verification token
//     const verificationToken = generateRandomToken()

//     // Create user
//     const user = await User.create({
//       email,
//       password,
//       verificationToken,
//     })

//     // Send verification email
//     await sendVerificationEmail(email, verificationToken)

//     // Generate JWT
//     const token = generateToken({ id: user._id })

//     res.status(201).json({
//       status: 'success',
//       message: 'Registration successful. Please verify your email.',
//       token,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.verifyEmail = async (req, res, next) => {
//   try {
//     const { token } = req.params

//     const user = await User.findOne({ verificationToken: token })

//     if (!user) {
//       return next(new AppError('Invalid verification token', 400))
//     }

//     user.isEmailVerified = true
//     user.verificationToken = undefined
//     await user.save()

//     res.status(200).json({
//       status: 'success',
//       message: 'Email verified successfully',
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.login = async (req, res, next) => {
//   try {
//     // Validate input
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

//     // Check if user exists
//     const user = await User.findOne({ email }).select('+password')
//     if (!user) {
//       return next(new AppError('Invalid email or password', 401))
//     }

//     // Check password
//     const isPasswordValid = await bcrypt.compare(password, user.password)
//     if (!isPasswordValid) {
//       return next(new AppError('Invalid email or password', 401))
//     }

//     // Generate JWT
//     const token = generateToken({ id: user._id })

//     // Remove password from output
//     user.password = undefined

//     res.status(200).json({
//       status: 'success',
//       token,
//       user,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.forgotPassword = async (req, res, next) => {
//   try {
//     // Validate input
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

//     // Generate reset token
//     const resetToken = generateRandomToken()
//     user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex')

//     user.resetPasswordExpires = Date.now() + parseInt(process.env.PASSWORD_RESET_TOKEN_EXPIRES_IN)
//     await user.save()

//     // Send password reset email
//     try {
//       await sendPasswordResetEmail(email, resetToken)

//       res.status(200).json({
//         status: 'success',
//         message: 'Password reset link sent to email',
//       })
//     } catch (error) {
//       user.resetPasswordToken = undefined
//       user.resetPasswordExpires = undefined
//       await user.save()

//       return next(new AppError('Error sending password reset email. Please try again later.', 500))
//     }
//   } catch (error) {
//     next(error)
//   }
// }

// exports.resetPassword = async (req, res, next) => {
//   try {
//     // Validate input
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

//     const { token, password } = value

//     // Hash token
//     const hashedToken = crypto.createHash('sha256').update(token).digest('hex')

//     const user = await User.findOne({
//       resetPasswordToken: hashedToken,
//       resetPasswordExpires: { $gt: Date.now() },
//     })

//     if (!user) {
//       return next(new AppError('Invalid or expired reset token', 400))
//     }

//     // Update password
//     user.password = password
//     user.resetPasswordToken = undefined
//     user.resetPasswordExpires = undefined
//     await user.save()

//     res.status(200).json({
//       status: 'success',
//       message: 'Password reset successful',
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.changePassword = async (req, res, next) => {
//   try {
//     // Validate input
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

//     // Get user with password
//     const user = await User.findById(req.user._id).select('+password')

//     // Check current password
//     const isPasswordValid = await bcrypt.compare(currentPassword, user.password)
//     if (!isPasswordValid) {
//       return next(new AppError('Current password is incorrect', 401))
//     }

//     // Update password
//     user.password = newPassword
//     await user.save()

//     res.status(200).json({
//       status: 'success',
//       message: 'Password changed successfully',
//     })
//   } catch (error) {
//     next(error)
//   }
// }
