const Joi = require('joi')
const mongoose = require('mongoose')
const { Module, Course, Lesson, User, Progress } = require('../models')
const { AppError } = require('../utils/errors')

// Validation Schemas
const moduleSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow(''),
  order: Joi.number().integer().min(1).required(),
  isAccessible: Joi.boolean(),
  prerequisites: Joi.array().items(Joi.string().regex(/^[0-9a-fA-F]{24}$/)),
  dependencies: Joi.array().items(
    Joi.object({
      module: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
      requiredCompletion: Joi.number().min(0).max(100),
    })
  ),
}).options({ abortEarly: false })

const updateModuleSchema = moduleSchema.fork(['title', 'description', 'order', 'isAccessible', 'prerequisites', 'dependencies'], (schema) => schema.optional())

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
    .required(),
}).options({ abortEarly: false })

// Helper function to check for circular dependencies
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

// Helper function to check prerequisites completion
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
      const requiredCompletion = module.dependencies?.[0]?.requiredCompletion || 100

      return progress.progress >= requiredCompletion
    })
  )

  return results.every((result) => result)
}

exports.createModule = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = moduleSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const existingModule = await Module.findOne({
      course: req.params.courseId,
      order: value.order,
      isDeleted: false,
    }).session(session)

    if (existingModule) {
      await session.abortTransaction()
      return next(new AppError('A module with this order number already exists', 400))
    }

    if (value.prerequisites?.length > 0) {
      const prereqModules = await Module.find({
        _id: { $in: value.prerequisites },
        course: req.params.courseId,
        isDeleted: false,
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

    const module = await Module.create(
      [
        {
          ...value,
          course: req.params.courseId,
        },
      ],
      { session }
    )

    await session.commitTransaction()

    const populatedModule = await Module.findById(module[0]._id).populate([
      {
        path: 'prerequisites',
        select: 'title order',
      },
      {
        path: 'dependencies.module',
        select: 'title order',
      },
    ])

    res.status(201).json({
      status: 'success',
      data: populatedModule,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getModules = async (req, res, next) => {
  try {
    const modules = await Module.find({
      course: req.params.courseId,
      isDeleted: false,
    })
      .populate([
        {
          path: 'prerequisites',
          select: 'title order',
        },
        {
          path: 'dependencies.module',
          select: 'title order',
        },
      ])
      .sort('order')

    const enrollment = await User.findOne(
      {
        _id: req.user._id,
        'enrolledCourses.course': req.params.courseId,
      },
      { 'enrolledCourses.$': 1 }
    )

    const modulesWithStatus = await Promise.all(
      modules.map(async (module) => {
        const moduleObj = module.toObject()

        if (enrollment) {
          const enrolledCourse = enrollment.enrolledCourses[0]
          const hasAccess = enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === module._id.toString())

          const progress = hasAccess
            ? await Progress.findOne({
                user: req.user._id,
                course: req.params.courseId,
                module: module._id,
              })
            : null

          moduleObj.enrollment = {
            hasAccess,
            type: enrolledCourse.enrollmentType,
            progress: progress
              ? {
                  overall: progress.progress,
                  completedLessons: progress.completedLessons,
                  completedQuizzes: progress.completedQuizzes,
                  lastAccessed: progress.lastAccessed,
                }
              : null,
          }

          if (module.prerequisites?.length > 0) {
            moduleObj.prerequisitesMet = await checkPrerequisitesCompletion(module.prerequisites, req.user._id, req.params.courseId)
          }
        }

        return moduleObj
      })
    )

    res.status(200).json({
      status: 'success',
      data: modulesWithStatus,
    })
  } catch (error) {
    next(error)
  }
}
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
          select: 'title type passingScore'
        }
      }
    ])

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

    const moduleObj = module.toObject()

    if (enrollment) {
      const enrolledCourse = enrollment.enrolledCourses[0]
      const hasAccess = enrolledCourse.enrollmentType === 'full' ||
        enrolledCourse.enrolledModules.some(em => 
          em.module.toString() === module._id.toString()
        )

      if (hasAccess) {
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
      status: 'success',
      data: moduleObj
    })
  } catch (error) {
    next(error)
  }
}

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

      if (await hasCircularDependency(value.prerequisites, req.params.courseId, req.params.moduleId)) {
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
      status: 'success',
      data: module
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

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

    // Check if any students are enrolled in this module
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
      status: 'success',
      message: 'Module deleted successfully'
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

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
        select: 'title type passingScore'
      }
    })

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
      return next(new AppError('You are not enrolled in this course', 403))
    }

    const enrolledCourse = enrollment.enrolledCourses[0]
    const hasAccess = enrolledCourse.enrollmentType === 'full' ||
      enrolledCourse.enrolledModules.some(em => 
        em.module.toString() === module._id.toString()
      )

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const progress = await Progress.findOne({
      user: req.user._id,
      course: req.params.courseId,
      module: module._id
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
      status: 'success',
      data: lessons
    })
  } catch (error) {
    next(error)
  }
}

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
      status: 'success',
      data: updatedModules
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

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
      status: 'success',
      data: module
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getModuleEnrollmentStatus = async (req, res, next) => {
  try {
    const module = await Module.findOne({
      _id: req.params.moduleId,
      course: req.params.courseId,
      isDeleted: false,
    }).populate('prerequisites', 'title order')

    if (!module) {
      return next(new AppError('Module not found', 404))
    }

    const enrollment = await User.findOne(
      {
        _id: req.user._id,
        'enrolledCourses.course': req.params.courseId,
      },
      { 'enrolledCourses.$': 1 }
    )

    if (!enrollment) {
      return res.status(200).json({
        status: 'success',
        data: {
          hasAccess: false,
          reason: 'not_enrolled_in_course',
        },
      })
    }

    const enrolledCourse = enrollment.enrolledCourses[0]
    const hasAccess = enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === module._id.toString())

    if (!hasAccess) {
      return res.status(200).json({
        status: 'success',
        data: {
          hasAccess: false,
          reason: 'module_not_purchased',
          enrollmentType: enrolledCourse.enrollmentType,
        },
      })
    }

    // Check prerequisites if they exist
    let prerequisitesStatus = null
    if (module.prerequisites?.length > 0) {
      prerequisitesStatus = await Promise.all(
        module.prerequisites.map(async (prereq) => {
          const progress = await Progress.findOne({
            user: req.user._id,
            course: req.params.courseId,
            module: prereq._id,
          })

          const dependency = module.dependencies?.find((d) => d.module.toString() === prereq._id.toString())

          const requiredCompletion = dependency?.requiredCompletion || 100

          return {
            moduleId: prereq._id,
            title: prereq.title,
            order: prereq.order,
            required: requiredCompletion,
            completed: progress?.progress || 0,
            isMet: (progress?.progress || 0) >= requiredCompletion,
          }
        })
      )
    }

    // Get current module progress
    const progress = await Progress.findOne({
      user: req.user._id,
      course: req.params.courseId,
      module: module._id,
    })

    res.status(200).json({
      status: 'success',
      data: {
        hasAccess: true,
        enrollmentType: enrolledCourse.enrollmentType,
        progress: progress
          ? {
              overall: progress.progress,
              completedLessons: progress.completedLessons.length,
              totalLessons:
                progress.completedLessons.length +
                (await Lesson.countDocuments({
                  module: module._id,
                  _id: { $nin: progress.completedLessons },
                  isDeleted: false,
                })),
              completedQuizzes: progress.completedQuizzes.length,
              lastAccessed: progress.lastAccessed,
            }
          : null,
        prerequisites: prerequisitesStatus,
        prerequisitesMet: !prerequisitesStatus || prerequisitesStatus.every((p) => p.isMet),
      },
    })
  } catch (error) {
    next(error)
  }
}