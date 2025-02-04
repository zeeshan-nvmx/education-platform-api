// module.controller.js
const Joi = require('joi')
const mongoose = require('mongoose')
const { Module, Course, Lesson, User, Progress } = require('../models')
const { AppError } = require('../utils/errors')

// Helper function to check if user has admin privileges
const hasAdminAccess = (user) => {
  return ['admin', 'subAdmin', 'moderator'].includes(user?.role);
};

// Validation Schemas
const moduleSchema = Joi.object({
  title: Joi.string().required().trim(),
  description: Joi.string().allow('').trim(),
  order: Joi.number().integer().min(1).required(),
  isAccessible: Joi.boolean().default(true),
  prerequisites: Joi.array().items(Joi.string().regex(/^[0-9a-fA-F]{24}$/)),
  dependencies: Joi.array().items(
    Joi.object({
      module: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
      requiredCompletion: Joi.number().min(0).max(100),
    })
  ),
}).options({ abortEarly: false })

const updateModuleSchema = Joi.object({
  title: Joi.string().trim(),
  description: Joi.string().allow('').trim(),
  order: Joi.number().integer().min(1),
  isAccessible: Joi.boolean(),
  prerequisites: Joi.array().items(Joi.string().regex(/^[0-9a-fA-F]{24}$/)),
  dependencies: Joi.array().items(
    Joi.object({
      module: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
      requiredCompletion: Joi.number().min(0).max(100),
    })
  ),
}).options({ abortEarly: false })

const prerequisitesSchema = Joi.object({
  prerequisites: Joi.array()
    .items(Joi.string().regex(/^[0-9a-fA-F]{24}$/))
    .required(),
  dependencies: Joi.array().items(
    Joi.object({
      module: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
      requiredCompletion: Joi.number().min(0).max(100),
    })
  ),
}).options({ abortEarly: false })

const reorderSchema = Joi.object({
  moduleOrders: Joi.array()
    .items(
      Joi.object({
        moduleId: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
        order: Joi.number().integer().min(1),
      })
    )
    .required()
    .min(1),
}).options({ abortEarly: false })

// Helper Functions
async function hasCircularDependency(prerequisites, courseId, currentModuleId = null) {
  const visited = new Set()
  const recursionStack = new Set()

  async function dfs(moduleId) {
    visited.add(moduleId.toString())
    recursionStack.add(moduleId.toString())

    const module = await Module.findOne({
      _id: moduleId,
      course: courseId,
      isDeleted: false,
    })

    if (!module) return false

    for (const prereq of module.prerequisites || []) {
      const prereqId = prereq.toString()

      if (currentModuleId && prereqId === currentModuleId.toString()) {
        return true
      }

      if (!visited.has(prereqId)) {
        if (await dfs(prereqId)) {
          return true
        }
      } else if (recursionStack.has(prereqId)) {
        return true
      }
    }

    recursionStack.delete(moduleId.toString())
    return false
  }

  for (const prereqId of prerequisites) {
    if (!visited.has(prereqId.toString())) {
      if (await dfs(prereqId)) {
        return true
      }
    }
  }

  return false
}

async function checkPrerequisitesCompletion(prerequisites, userId, courseId) {
  const results = await Promise.all(
    prerequisites.map(async (prereqId) => {
      const progress = await Progress.findOne({
        user: userId,
        course: courseId,
        module: prereqId,
      })

      if (!progress) return false

      const module = await Module.findById(prereqId)
      const dependency = module.dependencies?.find((d) => d.module.toString() === prereqId.toString())
      const requiredCompletion = dependency?.requiredCompletion || 100

      return progress.progress >= requiredCompletion
    })
  )

  return results.every((result) => result)
}

// Check if user has access to module (either full course or specific module)
async function hasModuleAccess(userId, courseId, moduleId) {
  const user = await User.findById(userId)

  if (!user) return false

  const enrollment = user.enrolledCourses.find((ec) => ec.course.toString() === courseId)

  if (!enrollment) return false

  // Check for full course access
  if (enrollment.enrollmentType === 'full') {
    return true
  }

  // Check for specific module access
  return enrollment.enrolledModules.some((em) => em.module.toString() === moduleId)
}

// Create Module
exports.createModule = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = moduleSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    // Check for existing module with same order
    const existingModule = await Module.findOne({
      course: req.params.courseId,
      order: value.order,
      isDeleted: false
    }).session(session)

    if (existingModule) {
      await session.abortTransaction()
      return next(new AppError('A module with this order number already exists', 400))
    }

    // Validate prerequisites if provided
    if (value.prerequisites?.length > 0) {
      const prereqModules = await Module.find({
        _id: { $in: value.prerequisites },
        course: req.params.courseId,
        isDeleted: false
      }).session(session)

      if (prereqModules.length !== value.prerequisites.length) {
        await session.abortTransaction()
        return next(new AppError('One or more prerequisites are invalid', 400))
      }

      if (await hasCircularDependency(value.prerequisites, req.params.courseId)) {
        await session.abortTransaction()
        return next(new AppError('Circular dependency detected in prerequisites', 400))
      }
    }

    // Create module
    const module = await Module.create([{
      ...value,
      course: req.params.courseId
    }], { session })

    await session.commitTransaction()

    // Populate references
    const populatedModule = await Module.findById(module[0]._id)
      .populate([
        {
          path: 'prerequisites',
          select: 'title order',
          match: { isDeleted: false }
        },
        {
          path: 'dependencies.module',
          select: 'title order',
          match: { isDeleted: false }
        }
      ])

    res.status(201).json({
      message: 'module created successfully',
      data: populatedModule
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Get All Modules

exports.getModules = async (req, res, next) => {
  try {
    if (!req.user?._id) {
      return next(new AppError('Authentication required', 401))
    }

    // Get all modules first
    const modules = await Module.find({
      course: req.params.courseId,
      isDeleted: false,
    })
      .populate([
        {
          path: 'prerequisites',
          select: 'title order',
          match: { isDeleted: false },
        },
        {
          path: 'dependencies.module',
          select: 'title order',
          match: { isDeleted: false },
        },
      ])
      .sort('order')
      .lean()

    // If user has admin access, return all modules with full access
    if (hasAdminAccess(req.user)) {
      const modulesWithAccess = modules.map((module) => ({
        ...module,
        enrollment: {
          hasAccess: true,
          type: 'admin',
          progress: null,
        },
      }))

      return res.status(200).json({
        status: 'success',
        message: 'Modules fetched successfully',
        data: modulesWithAccess,
      })
    }

    // For regular users, check enrollment
    const user = await User.findById(req.user._id).select('enrolledCourses').lean()

    if (!user) {
      return next(new AppError('User not found', 404))
    }

    const enrolledCourse = user.enrolledCourses?.find((course) => course?.course?.toString() === req.params.courseId)

    const modulesWithStatus = modules.map((module) => {
      const moduleObj = {
        ...module,
        enrollment: {
          hasAccess: false,
          type: null,
          progress: null,
        },
      }

      if (enrolledCourse) {
        const hasFullAccess = enrolledCourse.enrollmentType === 'full'
        const hasModuleAccess = enrolledCourse.enrolledModules?.some((em) => em?.module?.toString() === module._id.toString())

        moduleObj.enrollment = {
          hasAccess: hasFullAccess || hasModuleAccess,
          type: enrolledCourse.enrollmentType,
        }
      }

      return moduleObj
    })

    res.status(200).json({
      status: 'success',
      message: 'Modules fetched successfully',
      data: modulesWithStatus,
    })
  } catch (error) {
    next(error)
  }
}



// Get Single Module

exports.getModule = async (req, res, next) => {
  try {
    const module = await Module.findOne({
      _id: req.params.moduleId,
      course: req.params.courseId,
      isDeleted: false
    }).populate([
      {
        path: 'prerequisites',
        select: 'title order',
        match: { isDeleted: false }
      },
      {
        path: 'dependencies.module',
        select: 'title order',
        match: { isDeleted: false }
      },
      {
        path: 'lessons',
        match: { isDeleted: false },
        select: 'title description order videoUrl duration requireQuizPass',
        options: { sort: { order: 1 } },
        populate: {
          path: 'quiz',
          select: 'title type passingScore',
          match: { isDeleted: false }
        }
      }
    ])

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    // Get enrollment and progress information
    const enrollment = await User.findOne(
      {
        _id: req.user._id,
        'enrolledCourses.course': req.params.courseId
      },
      { 'enrolledCourses.$': 1 }
    )

    const moduleObj = module.toObject()

    if (enrollment) {
      const enrolledCourse = enrollment.enrolledCourses[0]
      const hasFullAccess = enrolledCourse.enrollmentType === 'full'
      const hasModuleAccess = enrolledCourse.enrolledModules.some(
        em => em.module.toString() === module._id.toString()
      )

      if (hasFullAccess || hasModuleAccess) {
        const progress = await Progress.findOne({
          user: req.user._id,
          course: req.params.courseId,
          module: module._id
        })

        moduleObj.enrollment = {
          type: enrolledCourse.enrollmentType,
          progress: progress ? {
            overall: progress.progress,
            completedLessons: progress.completedLessons,
            completedQuizzes: progress.completedQuizzes,
            lastAccessed: progress.lastAccessed
          } : null
        }

        if (progress && moduleObj.lessons) {
          moduleObj.lessons = moduleObj.lessons.map(lesson => ({
            ...lesson,
            completed: progress.completedLessons.includes(lesson._id),
            quiz: lesson.quiz ? {
              ...lesson.quiz,
              completed: progress.completedQuizzes.includes(lesson.quiz._id)
            } : null
          }))
        }

        if (module.prerequisites?.length > 0) {
          moduleObj.prerequisitesMet = await checkPrerequisitesCompletion(
            module.prerequisites,
            req.user._id,
            req.params.courseId
          )
        }
      }
    }

    res.status(200).json({
      message: 'Module fetched successfully',
      data: moduleObj
    })
  } catch (error) {
    next(error)
  }
}

// Update Module
exports.updateModule = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = updateModuleSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    if (value.order) {
      const existingModule = await Module.findOne({
        course: req.params.courseId,
        order: value.order,
        _id: { $ne: req.params.moduleId },
        isDeleted: false
      }).session(session)

      if (existingModule) {
        await session.abortTransaction()
        return next(new AppError('A module with this order number already exists', 400))
      }
    }

    if (value.prerequisites?.length > 0) {
      const prereqModules = await Module.find({
        _id: { $in: value.prerequisites },
        course: req.params.courseId,
        isDeleted: false
      }).session(session)

      if (prereqModules.length !== value.prerequisites.length) {
        await session.abortTransaction()
        return next(new AppError('One or more prerequisites are invalid', 400))
      }

      if (await hasCircularDependency(
        value.prerequisites, 
        req.params.courseId, 
        req.params.moduleId
      )) {
        await session.abortTransaction()
        return next(new AppError('Circular dependency detected in prerequisites', 400))
      }
    }

    const module = await Module.findOneAndUpdate(
      {
        _id: req.params.moduleId,
        course: req.params.courseId,
        isDeleted: false
      },
      value,
      {
        new: true,
        runValidators: true,
        session
      }
    ).populate([
      {
        path: 'prerequisites',
        select: 'title order'
      },
      {
        path: 'dependencies.module',
        select: 'title order'
      }
    ])

    if (!module) {
      await session.abortTransaction()
      return next(new AppError('Module not found', 404))
    }

    await session.commitTransaction()

    res.status(200).json({
      message: 'Module updated successfully',
      data: module
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Delete Module
exports.deleteModule = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const module = await Module.findOne({
      _id: req.params.moduleId,
      course: req.params.courseId,
      isDeleted: false
    }).session(session)

    if (!module) {
      await session.abortTransaction()
      return next(new AppError('Module not found', 404))
    }

    // Check if any students are enrolled
    const enrolledStudents = await User.countDocuments({
      $or: [
        { 'enrolledCourses.enrollmentType': 'full', 'enrolledCourses.course': req.params.courseId },
        { 'enrolledCourses.enrolledModules.module': module._id }
      ]
    }).session(session)

    if (enrolledStudents > 0) {
      // Soft delete if there are enrolled students
      module.isDeleted = true
      await module.save({ session })

      // Soft delete all lessons in this module
      await Lesson.updateMany(
        { module: module._id },
        { isDeleted: true },
        { session }
      )
    } else {
      // Hard delete if no enrolled students
      await Promise.all([
        Module.deleteOne({ _id: module._id }).session(session),
        Lesson.deleteMany({ module: module._id }).session(session)
      ])

      // Update order of remaining modules
      await Module.updateMany(
        {
          course: req.params.courseId,
          order: { $gt: module.order }
        },
        { $inc: { order: -1 } },
        { session }
      )
    }

    // Remove this module from prerequisites of other modules
    await Module.updateMany(
      {
        course: req.params.courseId,
        prerequisites: module._id
      },
      {
        $pull: {
          prerequisites: module._id,
          dependencies: { module: module._id }
        }
      },
      { session }
    )

    await session.commitTransaction()

    res.status(200).json({
      message: 'Module deleted successfully'
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Get Module Lessons
exports.getModuleLessons = async (req, res, next) => {
  try {
    const module = await Module.findOne({
      _id: req.params.moduleId,
      course: req.params.courseId,
      isDeleted: false
    }).populate({
      path: 'lessons',
      match: { isDeleted: false },
      select: 'title description order videoUrl duration requireQuizPass',
      options: { sort: { order: 1 } },
      populate: {
        path: 'quiz',
        select: 'title type passingScore',
        match: { isDeleted: false }
      }
    })

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    const hasAccess = await hasModuleAccess(
      req.user._id,
      req.params.courseId,
      req.params.moduleId
    )

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const progress = await Progress.findOne({
      user: req.user._id,
      course: req.params.courseId,
      module: req.params.moduleId
    })

    const lessons = module.lessons.map(lesson => {
      const lessonObj = lesson.toObject()
      if (progress) {
        lessonObj.completed = progress.completedLessons.includes(lesson._id)
        if (lesson.quiz) {
          lessonObj.quiz.completed = progress.completedQuizzes.includes(lesson.quiz._id)
        }
      }
      return lessonObj
    })

    res.status(200).json({
      message: 'Lessons fetched successfully',
      data: lessons
    })
  } catch (error) {
    next(error)
  }
}

// Reorder Modules
exports.reorderModules = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = reorderSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    const { moduleOrders } = value

    // Verify all modules exist and belong to the course
    const modules = await Module.find({
      _id: { $in: moduleOrders.map(mo => mo.moduleId) },
      course: req.params.courseId,
      isDeleted: false
    }).session(session)

    if (modules.length !== moduleOrders.length) {
      await session.abortTransaction()
      return next(new AppError('One or more modules not found', 404))
    }

    // Check for duplicate order numbers
    const orders = moduleOrders.map(mo => mo.order)
    if (new Set(orders).size !== orders.length) {
      await session.abortTransaction()
      return next(new AppError('Duplicate order numbers not allowed', 400))
    }

    // Update module orders
    await Promise.all(
      moduleOrders.map(mo =>
        Module.findByIdAndUpdate(
          mo.moduleId,
          { order: mo.order },
          { session }
        )
      )
    )

    await session.commitTransaction()

    const updatedModules = await Module.find({
      course: req.params.courseId,
      isDeleted: false
    })
    .sort('order')
    .populate([
      {
        path: 'prerequisites',
        select: 'title order'
      },
      {
        path: 'dependencies.module',
        select: 'title order'
      }
    ])

    res.status(200).json({
      message: 'Modules reordered successfully',
      data: updatedModules
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Update Module Prerequisites
exports.updateModulePrerequisites = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = prerequisitesSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map(detail => ({
          field: detail.context.key,
          message: detail.message
        }))
      })
    }

    const prereqModules = await Module.find({
      _id: { $in: value.prerequisites },
      course: req.params.courseId,
      isDeleted: false
    }).session(session)

    if (prereqModules.length !== value.prerequisites.length) {
      await session.abortTransaction()
      return next(new AppError('One or more prerequisites are invalid', 400))
    }

    if (await hasCircularDependency(
      value.prerequisites,
      req.params.courseId,
      req.params.moduleId
    )) {
      await session.abortTransaction()
      return next(new AppError('Circular dependency detected in prerequisites', 400))
    }

    const module = await Module.findOneAndUpdate(
      {
        _id: req.params.moduleId,
        course: req.params.courseId,
        isDeleted: false
      },
      {
        prerequisites: value.prerequisites,
        dependencies: value.dependencies
      },
      {
        new: true,
        runValidators: true,
        session
      }
    ).populate([
      {
        path: 'prerequisites',
        select: 'title order'
      },
      {
        path: 'dependencies.module',
        select: 'title order'
      }
    ])

    if (!module) {
      await session.abortTransaction()
      return next(new AppError('Module not found', 404))
    }

    await session.commitTransaction()

    res.status(200).json({
      message: 'Module prerequisites updated successfully',
      data: module
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Get Module Enrollment Status
exports.getModuleEnrollmentStatus = async (req, res, next) => {
  try {
    const module = await Module.findOne({
      _id: req.params.moduleId,
      course: req.params.courseId,
      isDeleted: false
    }).populate('prerequisites', 'title order')

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    const enrollment = await User.findOne(
      {
        _id: req.user._id,
        'enrolledCourses.course': req.params.courseId
      },
      { 'enrolledCourses.$': 1 }
    )

    if (!enrollment) {
      return res.status(200).json({
        status: 'success',
        data: {
          hasAccess: false,
          reason: 'not_enrolled_in_course'
        }
      })
    }

    const enrolledCourse = enrollment.enrolledCourses[0]
    const hasAccess = enrolledCourse.enrollmentType === 'full' || 
      enrolledCourse.enrolledModules.some(em => em.module.toString() === module._id.toString())

    if (!hasAccess) {
      return res.status(200).json({
        status: 'success',
        message: 'Module enrollment status fetched successfully',
        data: {
          hasAccess: false,
          reason: 'module_not_purchased',
          enrollmentType: enrolledCourse.enrollmentType
        }
      })
    }

    // Check prerequisites if they exist
    let prerequisitesStatus = null
    if (module.prerequisites?.length > 0) {
      prerequisitesStatus = await Promise.all(
        module.prerequisites.map(async prereq => {
          const progress = await Progress.findOne({
            user: req.user._id,
            course: req.params.courseId,
            module: prereq._id
          })

          const dependency = module.dependencies?.find(d => 
            d.module.toString() === prereq._id.toString()
          )
          const requiredCompletion = dependency?.requiredCompletion || 100

          return {
            moduleId: prereq._id,
            title: prereq.title,
            order: prereq.order,
            required: requiredCompletion,
            completed: progress?.progress || 0,
            isMet: (progress?.progress || 0) >= requiredCompletion
          }
        })
      )
    }

    // Get current module progress
    const progress = await Progress.findOne({
      user: req.user._id,
      course: req.params.courseId,
      module: module._id
    })

    res.status(200).json({
      message: 'Module enrollment status fetched successfully',
      data: {
        hasAccess: true,
        enrollmentType: enrolledCourse.enrollmentType,
        progress: progress ? {
          overall: progress.progress,
          completedLessons: progress.completedLessons.length,
          totalLessons: await Lesson.countDocuments({
            module: module._id,
            isDeleted: false
          }),
          completedQuizzes: progress.completedQuizzes.length,
          lastAccessed: progress.lastAccessed
        } : null,
        prerequisites: prerequisitesStatus,
        prerequisitesMet: !prerequisitesStatus || prerequisitesStatus.every(p => p.isMet)
      }
    })
  } catch (error) {
    next(error)
  }
}
