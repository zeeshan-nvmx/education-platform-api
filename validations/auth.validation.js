const Joi = require('joi')

const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/

const signupSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().pattern(passwordRegex).required().messages({
    'string.pattern.base': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character',
    'any.required': 'Password is required',
  }),
  confirmPassword: Joi.string().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords do not match',
    'any.required': 'Please confirm your password',
  }),
}).options({ abortEarly: false })

const verifyEmailSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  otp: Joi.string()
    .length(6)
    .pattern(/^[0-9A-Z]+$/)
    .required()
    .messages({
      'string.length': 'OTP must be 6 characters long',
      'string.pattern.base': 'OTP must contain only numbers and uppercase letters',
      'any.required': 'OTP is required',
    }),
}).options({ abortEarly: false })

const loginSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  password: Joi.string().required().messages({
    'any.required': 'Password is required',
  }),
}).options({ abortEarly: false })

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
}).options({ abortEarly: false })

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Email is required',
  }),
  otp: Joi.string()
    .length(6)
    .pattern(/^[0-9A-Z]+$/)
    .required()
    .messages({
      'string.length': 'OTP must be 6 characters long',
      'string.pattern.base': 'OTP must contain only numbers and uppercase letters',
      'any.required': 'OTP is required',
    }),
  password: Joi.string().pattern(passwordRegex).required().messages({
    'string.pattern.base': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character',
    'any.required': 'Password is required',
  }),
  confirmPassword: Joi.string().valid(Joi.ref('password')).required().messages({
    'any.only': 'Passwords do not match',
    'any.required': 'Please confirm your password',
  }),
}).options({ abortEarly: false })

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required().messages({
    'any.required': 'Current password is required',
  }),
  newPassword: Joi.string().pattern(passwordRegex).required().messages({
    'string.pattern.base': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number and one special character',
    'any.required': 'New password is required',
  }),
  confirmNewPassword: Joi.string().valid(Joi.ref('newPassword')).required().messages({
    'any.only': 'Passwords do not match',
    'any.required': 'Please confirm your new password',
  }),
}).options({ abortEarly: false })

module.exports = {
  signupSchema,
  verifyEmailSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
}
