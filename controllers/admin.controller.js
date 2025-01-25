const Joi = require('joi')
const { User } = require('../models')
const { AppError } = require('../utils/errors')
const { sendVerificationOtp } = require('../utils/email')

// Validation Schemas
const createUserSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string()
    .min(8)
    .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
    .required()
    .messages({
      'string.min': 'Password must be at least 8 characters long',
      'string.pattern.base': 'Password must contain at least one uppercase letter, one lowercase letter, one number and one special character',
      'any.required': 'Password is required',
    }),
  role: Joi.string().valid('subAdmin', 'moderator').required().messages({
    'any.only': 'Role must be either subAdmin or moderator',
    'any.required': 'Role is required',
  }),
  firstName: Joi.string().trim().min(2).max(50).required().messages({
    'string.min': 'First name must be at least 2 characters long',
    'string.max': 'First name cannot exceed 50 characters',
    'any.required': 'First name is required',
  }),
  lastName: Joi.string().trim().min(2).max(50).required().messages({
    'string.min': 'Last name must be at least 2 characters long',
    'string.max': 'Last name cannot exceed 50 characters',
    'any.required': 'Last name is required',
  }),
}).options({ abortEarly: false })

const updateUserRoleSchema = Joi.object({
  role: Joi.string().valid('user', 'subAdmin', 'moderator').required().messages({
    'any.only': 'Role must be either user, subAdmin, or moderator',
    'any.required': 'Role is required',
  }),
}).options({ abortEarly: false })

// Helper function for validation error formatting
const formatValidationErrors = (error) => {
  return error.details.map((detail) => ({
    field: detail.context.key,
    message: detail.message,
  }))
}

// Helper function to generate 6-character alphanumeric OTP
const generateOTP = () => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let otp = ''
  for (let i = 0; i < 6; i++) {
    otp += chars[Math.floor(Math.random() * chars.length)]
  }
  return otp
}

// Controllers
exports.createUser = async (req, res, next) => {
  try {
    // Validate input
    const { error, value } = createUserSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: formatValidationErrors(error),
      })
    }

    const { email, password, role, firstName, lastName } = value

    // Check if user exists
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return next(new AppError('Email already registered', 400))
    }

    // Generate verification token
    const verificationToken = generateOTP()

    // Create user
    const user = await User.create({
      email,
      password,
      role,
      firstName,
      lastName,
      verificationToken,
      isEmailVerified: false,
    })

    // Send verification OTP
    await sendVerificationOtp(email, verificationToken)

    // Return success response without sensitive data
    res.status(201).json({
      message: `${role} account created successfully. Verification otp to their email has been sent.`,
      data: {
        _id: user._id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    })
  } catch (error) {
    next(error)
  }
}

// exports.getUsers = async (req, res, next) => {
//   try {
//     // Parse and validate pagination parameters
//     const page = Math.max(parseInt(req.query.page) || 1, 1) // Ensure page is at least 1
//     const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100) // Limit between 1 and 100
//     const role = req.query.role
//     const search = req.query.search?.trim()

//     const query = {}

//     // Add role filter if provided and valid
//     if (role && ['subAdmin', 'moderator', 'user'].includes(role)) {
//       query.role = role
//     }

//     // Add search filter if provided
//     if (search) {
//       query.$or = [{ email: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }, { lastName: { $regex: search, $options: 'i' } }]
//     }

//     // Get total count for pagination
//     const totalUsers = await User.countDocuments(query)
//     const totalPages = Math.ceil(totalUsers / limit)
//     const currentPage = Math.min(page, totalPages || 1) // Ensure page doesn't exceed total pages

//     // Fetch users with pagination
//     const users = await User.find(query)
//       .select('-password -verificationToken -resetPasswordToken -resetPasswordExpires')
//       .sort({ createdAt: -1 })
//       .skip((currentPage - 1) * limit)
//       .limit(limit)

//     res.status(200).json({
//       message: 'Users fetched successfully',
//       data: {
//         users,
//         pagination: {
//           currentPage,
//           totalPages,
//           totalUsers,
//           limit,
//           hasNextPage: currentPage < totalPages,
//           hasPrevPage: currentPage > 1,
//         },
//       },
//     })
//   } catch (error) {
//     next(error)
//   }
// }

exports.getUsers = async (req, res, next) => {
  try {
    // Parse and validate pagination parameters
    const page = Math.max(parseInt(req.query.page) || 1, 1) // Ensure page is at least 1
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100) // Limit between 1 and 100
    const role = req.query.role
    const search = req.query.search?.trim()
    const type = req.query.type 

    const query = {}

    // Handle type parameter for filtering non-basic users
    if (type === 'main') {
      query.role = { $ne: 'user' } // Exclude basic users
    } else if (type === 'all') {
      // Don't add any role filter to get all users
    } else if (role && ['subAdmin', 'moderator', 'user'].includes(role)) {
      // If no type is specified, fall back to specific role filter
      query.role = role
    }

    // Add search filter if provided
    if (search) {
      query.$or = [{ email: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }, { lastName: { $regex: search, $options: 'i' } }]
    }

    // Get total count for pagination
    const totalUsers = await User.countDocuments(query)
    const totalPages = Math.ceil(totalUsers / limit)
    const currentPage = Math.min(page, totalPages || 1) // Ensure page doesn't exceed total pages

    // Fetch users with pagination
    const users = await User.find(query)
      .select('-password -verificationToken -resetPasswordToken -resetPasswordExpires')
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * limit)
      .limit(limit)

    res.status(200).json({
      message: 'Users fetched successfully',
      data: {
        users,
        pagination: {
          currentPage,
          totalPages,
          totalUsers,
          limit,
          hasNextPage: currentPage < totalPages,
          hasPrevPage: currentPage > 1,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

exports.deleteUser = async (req, res, next) => {
  try {
    const { userId } = req.params

    const user = await User.findById(userId)

    if (!user) {
      return next(new AppError('User not found', 404))
    }

    // Prevent deleting an admin
    if (user.role === 'admin') {
      return next(new AppError('Admin users cannot be deleted', 403))
    }

    // Delete the user
    await User.findByIdAndDelete(userId)

    res.status(200).json({
      message: 'User deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

exports.updateUserRole = async (req, res, next) => {
  try {
    const { userId } = req.params

    // Validate input
    const { error, value } = updateUserRoleSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: formatValidationErrors(error),
      })
    }

    const { role } = value

    const user = await User.findById(userId)

    if (!user) {
      return next(new AppError('User not found', 404))
    }

    // Prevent modifying an admin's role
    if (user.role === 'admin') {
      return next(new AppError('Admin users role cannot be modified', 403))
    }

    // Update user role
    user.role = role
    await user.save()

    res.status(200).json({
      message: 'User role updated successfully',
      data: {
        _id: user._id,
        email: user.email,
        role: user.role,
      },
    })
  } catch (error) {
    next(error)
  }
}
