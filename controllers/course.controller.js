const Joi = require('joi')
const mongoose = require('mongoose')
const { Course, Module, User, Progress, Lesson, Quiz } = require('../models')
const { AppError } = require('../utils/errors')
const sanitizeHtml = require('sanitize-html')

// Validation Schemas
const courseSchema = Joi.object({
  title: Joi.string().trim().min(5).max(100).required().messages({
    'string.min': 'Title must be at least 5 characters long',
    'string.max': 'Title cannot exceed 100 characters',
    'any.required': 'Title is required',
  }),
  description: Joi.string().trim().min(20).max(2000).required().messages({
    'string.min': 'Description must be at least 20 characters long',
    'string.max': 'Description cannot exceed 2000 characters',
    'any.required': 'Description is required',
  }),
  category: Joi.string().trim().required().messages({
    'any.required': 'Category is required',
  }),
  price: Joi.number().min(0).required().messages({
    'number.min': 'Price cannot be negative',
    'any.required': 'Price is required',
  }),
  thumbnail: Joi.string().uri().allow('').messages({
    'string.uri': 'Thumbnail must be a valid URL',
  }),
  featured: Joi.boolean(),
}).options({ abortEarly: false })

const updateCourseSchema = courseSchema.fork(['title', 'description', 'category', 'price'], (schema) => schema.optional())

const querySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(100),
  category: Joi.string(),
  search: Joi.string(),
  minPrice: Joi.number().min(0),
  maxPrice: Joi.number().min(Joi.ref('minPrice')),
  sortBy: Joi.string().valid('createdAt', 'price', 'rating', 'totalStudents'),
  order: Joi.string().valid('asc', 'desc'),
})

exports.createCourse = async (req, res, next) => {
  try {
    const { error, value } = courseSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    // Check for duplicate title
    const existingCourse = await Course.findOne({ title: value.title })
    if (existingCourse) {
      return next(new AppError('A course with this title already exists', 400))
    }

    // Sanitize description
    value.description = sanitizeHtml(value.description, {
      allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
      allowedAttributes: {},
    })

    const course = await Course.create({
      ...value,
      creator: req.user._id,
    })

    const populatedCourse = await Course.findById(course._id).populate('creator', 'firstName lastName email')

    res.status(201).json({
      status: 'success',
      data: populatedCourse,
    })
  } catch (error) {
    next(error)
  }
}

exports.getAllCourses = async (req, res, next) => {
  try {
    const { error, value } = querySchema.validate(req.query)
    if (error) {
      return next(new AppError(error.details[0].message, 400))
    }

    const { page = 1, limit = 10, category, search, minPrice, maxPrice, sortBy = 'createdAt', order = 'desc' } = value

    const query = {}

    if (category) {
      query.category = category
    }

    if (search) {
      query.$text = { $search: search }
    }

    if (!isNaN(minPrice) || !isNaN(maxPrice)) {
      query.price = {}
      if (!isNaN(minPrice)) query.price.$gte = minPrice
      if (!isNaN(maxPrice)) query.price.$lte = maxPrice
    }

    const [totalCourses, courses] = await Promise.all([
      Course.countDocuments(query),
      Course.find(query)
        .select('-__v')
        .populate('creator', 'firstName lastName email')
        .sort({ [sortBy]: order === 'desc' ? -1 : 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ])

    const totalPages = Math.ceil(totalCourses / limit)

    res.status(200).json({
      status: 'success',
      data: {
        courses,
        pagination: {
          currentPage: page,
          totalPages,
          totalCourses,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

exports.getCourse = async (req, res, next) => {
  try {
    const course = await Course.findById(req.params.courseId)
      .populate('creator', 'firstName lastName email')
      .populate({
        path: 'modules',
        options: { sort: { order: 1 } },
        populate: {
          path: 'lessons',
          select: 'title description order videoUrl duration requireQuizPass',
          options: { sort: { order: 1 } },
        },
      })

    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const isCreator = course.creator._id.toString() === req.user?._id.toString()
    const isAdmin = req.user?.role === 'admin'
    const isEnrolled = req.user?.enrolledCourses?.some((enrollment) => enrollment.course.toString() === course._id.toString())

    if (!isCreator && !isAdmin && !course.featured && !isEnrolled) {
      const limitedCourse = {
        _id: course._id,
        title: course.title,
        description: course.description,
        category: course.category,
        price: course.price,
        thumbnail: course.thumbnail,
        creator: course.creator,
        rating: course.rating,
        totalStudents: course.totalStudents,
        featured: course.featured,
      }

      return res.status(200).json({
        status: 'success',
        data: limitedCourse,
      })
    }

    res.status(200).json({
      status: 'success',
      data: course,
    })
  } catch (error) {
    next(error)
  }
}

exports.updateCourse = async (req, res, next) => {
  try {
    const { error, value } = updateCourseSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    if (Object.keys(value).length === 0) {
      return next(new AppError('No update data provided', 400))
    }

    if (value.description) {
      value.description = sanitizeHtml(value.description, {
        allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br'],
        allowedAttributes: {},
      })
    }

    if (value.title) {
      const existingCourse = await Course.findOne({
        title: value.title,
        _id: { $ne: req.params.courseId },
      })
      if (existingCourse) {
        return next(new AppError('A course with this title already exists', 400))
      }
    }

    const course = await Course.findById(req.params.courseId)
    if (!course) {
      return next(new AppError('Course not found', 404))
    }

    const updatedCourse = await Course.findByIdAndUpdate(
      req.params.courseId,
      { ...value },
      {
        new: true,
        runValidators: true,
      }
    ).populate('creator', 'firstName lastName email')

    res.status(200).json({
      status: 'success',
      data: updatedCourse,
    })
  } catch (error) {
    next(error)
  }
}

exports.deleteCourse = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const course = await Course.findById(req.params.courseId).session(session)
    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    const activeEnrollments = await User.countDocuments({
      'enrolledCourses.course': course._id,
    }).session(session)

    if (activeEnrollments > 0) {
      // Soft delete if there are active enrollments
      course.isDeleted = true
      await course.save({ session })

      // Mark associated content as deleted
      await Promise.all([
        Module.updateMany({ course: course._id }, { isDeleted: true }, { session }),
        Lesson.updateMany({ module: { $in: await Module.find({ course: course._id }).distinct('_id') } }, { isDeleted: true }, { session }),
      ])
    } else {
      // Hard delete if no active enrollments
      await course.remove({ session })
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Course deleted successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getFeaturedCourses = async (req, res, next) => {
  try {
    const courses = await Course.find({ featured: true }).select('-__v').populate('creator', 'firstName lastName').sort('-rating').limit(6).lean()

    res.status(200).json({
      status: 'success',
      data: courses,
    })
  } catch (error) {
    next(error)
  }
}

exports.getCoursesByCategory = async (req, res, next) => {
  try {
    const { category } = req.params
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 10

    const [totalCourses, courses] = await Promise.all([
      Course.countDocuments({ category }),
      Course.find({ category })
        .select('-__v')
        .populate('creator', 'firstName lastName')
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ])

    const totalPages = Math.ceil(totalCourses / limit)

    res.status(200).json({
      status: 'success',
      data: {
        courses,
        pagination: {
          currentPage: page,
          totalPages,
          totalCourses,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    })
  } catch (error) {
    next(error)
  }
}

// const Joi = require('joi')
// const { Course, Module, Lesson } = require('../models')
// const { AppError } = require('../utils/errors')

// // Validation Schemas
// const courseSchema = Joi.object({
//   title: Joi.string().trim().min(5).max(100).required().messages({
//     'string.min': 'Title must be at least 5 characters long',
//     'string.max': 'Title cannot exceed 100 characters',
//     'any.required': 'Title is required',
//   }),
//   description: Joi.string().trim().min(20).max(2000).required().messages({
//     'string.min': 'Description must be at least 20 characters long',
//     'string.max': 'Description cannot exceed 2000 characters',
//     'any.required': 'Description is required',
//   }),
//   category: Joi.string().trim().required().messages({
//     'any.required': 'Category is required',
//   }),
//   price: Joi.number().min(0).required().messages({
//     'number.min': 'Price cannot be negative',
//     'any.required': 'Price is required',
//   }),
//   thumbnail: Joi.string().uri().messages({
//     'string.uri': 'Thumbnail must be a valid URL',
//   }),
//   featured: Joi.boolean(),
// }).options({ abortEarly: false })

// const updateCourseSchema = courseSchema.fork(['title', 'description', 'category', 'price'], (schema) => schema.optional())

// exports.createCourse = async (req, res, next) => {
//   try {
//     // Validate input
//     const { error, value } = courseSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     // Create course
//     const course = await Course.create({
//       ...value,
//       creator: req.user._id,
//     })

//     res.status(201).json({
//       status: 'success',
//       data: course,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.getAllCourses = async (req, res, next) => {
//   try {
//     const page = parseInt(req.query.page) || 1
//     const limit = parseInt(req.query.limit) || 10
//     const category = req.query.category
//     const search = req.query.search
//     const minPrice = parseFloat(req.query.minPrice)
//     const maxPrice = parseFloat(req.query.maxPrice)

//     const query = {}

//     // Add filters
//     if (category) {
//       query.category = category
//     }

//     if (search) {
//       query.$or = [{ title: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }]
//     }

//     if (!isNaN(minPrice) || !isNaN(maxPrice)) {
//       query.price = {}
//       if (!isNaN(minPrice)) query.price.$gte = minPrice
//       if (!isNaN(maxPrice)) query.price.$lte = maxPrice
//     }

//     const totalCourses = await Course.countDocuments(query)
//     const totalPages = Math.ceil(totalCourses / limit)

//     const courses = await Course.find(query)
//       .populate('creator', 'firstName lastName email')
//       .sort({ createdAt: -1 })
//       .skip((page - 1) * limit)
//       .limit(limit)

//     res.status(200).json({
//       status: 'success',
//       data: {
//         courses,
//         pagination: {
//           currentPage: page,
//           totalPages,
//           totalCourses,
//           hasNextPage: page < totalPages,
//           hasPrevPage: page > 1,
//         },
//       },
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.getCourse = async (req, res, next) => {
//   try {
//     const course = await Course.findById(req.params.courseId)
//       .populate('creator', 'firstName lastName email')
//       .populate({
//         path: 'modules',
//         options: { sort: { order: 1 } },
//         populate: {
//           path: 'lessons',
//           options: { sort: { order: 1 } },
//         },
//       })

//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     // If user is not creator and course is not featured, check if user is enrolled
//     if (course.creator._id.toString() !== req.user?._id.toString() && !course.featured && req.user?.role !== 'admin') {
//       const isEnrolled = req.user?.enrolledCourses.some((enrollment) => enrollment.course.toString() === course._id.toString())

//       if (!isEnrolled) {
//         // Return limited course data for non-enrolled users
//         const limitedCourse = {
//           _id: course._id,
//           title: course.title,
//           description: course.description,
//           category: course.category,
//           price: course.price,
//           thumbnail: course.thumbnail,
//           creator: course.creator,
//           rating: course.rating,
//           totalStudents: course.totalStudents,
//           featured: course.featured,
//         }

//         return res.status(200).json({
//           status: 'success',
//           data: limitedCourse,
//         })
//       }
//     }

//     res.status(200).json({
//       status: 'success',
//       data: course,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.updateCourse = async (req, res, next) => {
//   try {
//     // Validate input
//     const { error, value } = updateCourseSchema.validate(req.body)
//     if (error) {
//       return res.status(400).json({
//         status: 'error',
//         errors: error.details.map((detail) => ({
//           field: detail.context.key,
//           message: detail.message,
//         })),
//       })
//     }

//     const course = await Course.findById(req.params.courseId)

//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     // Check if user is authorized to update the course
//     if (course.creator.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
//       return next(new AppError('Not authorized to update this course', 403))
//     }

//     const updatedCourse = await Course.findByIdAndUpdate(req.params.courseId, value, { new: true, runValidators: true }).populate('creator', 'firstName lastName email')

//     res.status(200).json({
//       status: 'success',
//       data: updatedCourse,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.deleteCourse = async (req, res, next) => {
//   try {
//     const course = await Course.findById(req.params.courseId)

//     if (!course) {
//       return next(new AppError('Course not found', 404))
//     }

//     // Check if user is authorized to delete the course
//     if (course.creator.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
//       return next(new AppError('Not authorized to delete this course', 403))
//     }

//     // Delete all associated modules and lessons
//     const modules = await Module.find({ course: course._id })
//     for (const module of modules) {
//       await Lesson.deleteMany({ module: module._id })
//       await Module.findByIdAndDelete(module._id)
//     }

//     await Course.findByIdAndDelete(req.params.courseId)

//     res.status(200).json({
//       status: 'success',
//       message: 'Course and all associated content deleted successfully',
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.getFeaturedCourses = async (req, res, next) => {
//   try {
//     const courses = await Course.find({ featured: true }).populate('creator', 'firstName lastName').sort('-rating').limit(6)

//     res.status(200).json({
//       status: 'success',
//       data: courses,
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// exports.getCoursesByCategory = async (req, res, next) => {
//   try {
//     const { category } = req.params
//     const page = parseInt(req.query.page) || 1
//     const limit = parseInt(req.query.limit) || 10

//     const totalCourses = await Course.countDocuments({ category })
//     const totalPages = Math.ceil(totalCourses / limit)

//     const courses = await Course.find({ category })
//       .populate('creator', 'firstName lastName')
//       .sort('-createdAt')
//       .skip((page - 1) * limit)
//       .limit(limit)

//     res.status(200).json({
//       status: 'success',
//       data: {
//         courses,
//         pagination: {
//           currentPage: page,
//           totalPages,
//           totalCourses,
//           hasNextPage: page < totalPages,
//           hasPrevPage: page > 1,
//         },
//       },
//     })
//   } catch (error) {
//     next(error)
//   }
// }
