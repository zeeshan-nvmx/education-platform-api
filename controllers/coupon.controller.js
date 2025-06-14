const Joi = require('joi')
const { Discount, Course, Module } = require('../models')
const { AppError } = require('../utils/errors')

// Validation Schemas
const createCouponSchema = Joi.object({
  code: Joi.string().uppercase().alphanum().min(4).max(20).required().messages({
    'string.min': 'Coupon code must be at least 4 characters',
    'string.max': 'Coupon code cannot exceed 20 characters',
    'string.alphanum': 'Coupon code must contain only letters and numbers',
    'any.required': 'Coupon code is required',
  }),
  type: Joi.string().valid('percentage', 'fixed').required().messages({
    'any.only': 'Type must be either percentage or fixed',
    'any.required': 'Discount type is required',
  }),
  value: Joi.number()
    .positive()
    .required()
    .when('type', {
      is: 'percentage',
      then: Joi.number().max(100).messages({
        'number.max': 'Percentage discount cannot exceed 100%',
      }),
    })
    .messages({
      'number.positive': 'Discount value must be positive',
      'any.required': 'Discount value is required',
    }),
  course: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .allow(null)
    .optional(),
  module: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .allow(null)
    .optional(),
  startDate: Joi.date().iso().default(Date.now),
  endDate: Joi.date().iso().greater(Joi.ref('startDate')).required().messages({
    'date.greater': 'End date must be after start date',
    'any.required': 'End date is required',
  }),
  maxUses: Joi.number().integer().positive().allow(null).optional(),
}).options({ abortEarly: false })

const updateCouponSchema = Joi.object({
  type: Joi.string().valid('percentage', 'fixed'),
  value: Joi.number()
    .positive()
    .when('type', {
      is: 'percentage',
      then: Joi.number().max(100),
    }),
  startDate: Joi.date().iso(),
  endDate: Joi.date()
    .iso()
    .when('startDate', {
      is: Joi.exist(),
      then: Joi.date().greater(Joi.ref('startDate')),
    }),
  maxUses: Joi.number().integer().positive().allow(null),
}).options({ abortEarly: false })

// Create a new coupon
exports.createCoupon = async (req, res, next) => {
  try {
    const { error, value } = createCouponSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    // Check if coupon code already exists
    const existingCoupon = await Discount.findOne({
      code: value.code.toUpperCase(),
      isDeleted: false,
    })

    if (existingCoupon) {
      return next(new AppError('A coupon with this code already exists', 400))
    }

    // Validate course/module if provided
    if (value.course) {
      const course = await Course.findById(value.course)
      if (!course) {
        return next(new AppError('Invalid course ID', 400))
      }
    }

    if (value.module) {
      const module = await Module.findById(value.module)
      if (!module) {
        return next(new AppError('Invalid module ID', 400))
      }
    }

    // Create the coupon
    const coupon = await Discount.create({
      ...value,
      code: value.code.toUpperCase(),
      createdBy: req.user._id,
      usedCount: 0,
    })

    res.status(201).json({
      status: 'success',
      message: 'Coupon created successfully',
      data: coupon,
    })
  } catch (error) {
    next(error)
  }
}

// Get all coupons
exports.getAllCoupons = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 10
    const skip = (page - 1) * limit

    // Build query
    const query = { isDeleted: false }

    // Add filters
    if (req.query.active === 'true') {
      query.startDate = { $lte: new Date() }
      query.endDate = { $gte: new Date() }
    }

    if (req.query.course) {
      query.course = req.query.course
    }

    if (req.query.module) {
      query.module = req.query.module
    }

    const [totalCoupons, coupons] = await Promise.all([
      Discount.countDocuments(query),
      Discount.find(query)
        .populate('course', 'title')
        .populate('module', 'title')
        .populate('createdBy', 'firstName lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ])

    const totalPages = Math.ceil(totalCoupons / limit)

    res.status(200).json({
      status: 'success',
      message: 'Coupons fetched successfully',
      data: {
        coupons: coupons.map((coupon) => ({
          ...coupon,
          isActive: new Date() >= coupon.startDate && new Date() <= coupon.endDate,
          remainingUses: coupon.maxUses ? coupon.maxUses - coupon.usedCount : null,
        })),
        pagination: {
          currentPage: page,
          totalPages,
          totalCoupons,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get single coupon
exports.getCoupon = async (req, res, next) => {
  try {
    const coupon = await Discount.findOne({
      _id: req.params.couponId,
      isDeleted: false,
    })
      .populate('course', 'title')
      .populate('module', 'title')
      .populate('createdBy', 'firstName lastName')

    if (!coupon) {
      return next(new AppError('Coupon not found', 404))
    }

    res.status(200).json({
      status: 'success',
      message: 'Coupon fetched successfully',
      data: {
        ...coupon.toObject(),
        isActive: new Date() >= coupon.startDate && new Date() <= coupon.endDate,
        remainingUses: coupon.maxUses ? coupon.maxUses - coupon.usedCount : null,
      },
    })
  } catch (error) {
    next(error)
  }
}

// Update coupon
exports.updateCoupon = async (req, res, next) => {
  try {
    const { error, value } = updateCouponSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const coupon = await Discount.findOne({
      _id: req.params.couponId,
      isDeleted: false,
    })

    if (!coupon) {
      return next(new AppError('Coupon not found', 404))
    }

    // Update the coupon
    Object.keys(value).forEach((key) => {
      coupon[key] = value[key]
    })

    await coupon.save()

    res.status(200).json({
      status: 'success',
      message: 'Coupon updated successfully',
      data: coupon,
    })
  } catch (error) {
    next(error)
  }
}

// Delete coupon (soft delete)
exports.deleteCoupon = async (req, res, next) => {
  try {
    const coupon = await Discount.findOne({
      _id: req.params.couponId,
      isDeleted: false,
    })

    if (!coupon) {
      return next(new AppError('Coupon not found', 404))
    }

    coupon.isDeleted = true
    await coupon.save()

    res.status(200).json({
      status: 'success',
      message: 'Coupon deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

// Validate coupon for users
exports.validateCoupon = async (req, res, next) => {
  try {
    const { code, courseId, moduleId } = req.body

    if (!code) {
      return next(new AppError('Coupon code is required', 400))
    }

    // Find the coupon
    const coupon = await Discount.findOne({
      code: code.toUpperCase(),
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() },
      isDeleted: false,
    })

    if (!coupon) {
      return next(new AppError('Invalid or expired coupon code', 400))
    }

    // Check if coupon has remaining uses
    if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
      return next(new AppError('This coupon has reached its usage limit', 400))
    }

    // Check if coupon is for specific course/module
    if (coupon.course && courseId) {
      if (coupon.course.toString() !== courseId) {
        return next(new AppError('This coupon is not valid for this course', 400))
      }
    }

    if (coupon.module && moduleId) {
      if (coupon.module.toString() !== moduleId) {
        return next(new AppError('This coupon is not valid for this module', 400))
      }
    }

    // If coupon is global (no specific course/module), it's valid
    const isGlobal = !coupon.course && !coupon.module

    res.status(200).json({
      status: 'success',
      message: 'Coupon is valid',
      data: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        isGlobal,
        applicableTo: coupon.course ? 'course' : coupon.module ? 'module' : 'all',
      },
    })
  } catch (error) {
    next(error)
  }
}

// Get coupon statistics
exports.getCouponStats = async (req, res, next) => {
  try {
    const stats = await Discount.aggregate([
      { $match: { isDeleted: false } },
      {
        $facet: {
          overview: [
            {
              $group: {
                _id: null,
                totalCoupons: { $sum: 1 },
                activeCoupons: {
                  $sum: {
                    $cond: [
                      {
                        $and: [{ $lte: ['$startDate', new Date()] }, { $gte: ['$endDate', new Date()] }],
                      },
                      1,
                      0,
                    ],
                  },
                },
                totalUsed: { $sum: '$usedCount' },
              },
            },
          ],
          byType: [
            {
              $group: {
                _id: '$type',
                count: { $sum: 1 },
                totalUsed: { $sum: '$usedCount' },
              },
            },
          ],
          topCoupons: [
            { $sort: { usedCount: -1 } },
            { $limit: 5 },
            {
              $project: {
                code: 1,
                type: 1,
                value: 1,
                usedCount: 1,
                maxUses: 1,
              },
            },
          ],
        },
      },
    ])

    res.status(200).json({
      status: 'success',
      message: 'Coupon statistics fetched successfully',
      data: {
        overview: stats[0].overview[0] || {
          totalCoupons: 0,
          activeCoupons: 0,
          totalUsed: 0,
        },
        byType: stats[0].byType,
        topCoupons: stats[0].topCoupons,
      },
    })
  } catch (error) {
    next(error)
  }
}
