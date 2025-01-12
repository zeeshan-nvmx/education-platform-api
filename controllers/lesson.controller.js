const Joi = require('joi')
const mongoose = require('mongoose')
const { Lesson, Module, Progress, Quiz, User } = require('../models')
const { AppError } = require('../utils/errors')
const CloudflareService = require('../utils/cloudflare')

// Validation Schemas
const lessonSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().allow(''),
  order: Joi.number().integer().min(1).required(),
  requireQuizPass: Joi.boolean(),
}).options({ abortEarly: false })

const updateLessonSchema = lessonSchema.fork(['title', 'description', 'order', 'requireQuizPass'], (schema) => schema.optional())

const reorderSchema = Joi.object({
  lessonOrders: Joi.array()
    .items(
      Joi.object({
        lessonId: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
        order: Joi.number().integer().min(1),
      })
    )
    .required(),
}).options({ abortEarly: false })

// Helper Functions
async function checkModuleAccess(userId, courseId, moduleId) {
  const user = await User.findOne({
    _id: userId,
    'enrolledCourses.course': courseId,
  })

  if (!user) return false

  const enrollment = user.enrolledCourses.find((ec) => ec.course.toString() === courseId)

  if (!enrollment) return false

  if (enrollment.enrollmentType === 'full') return true

  return enrollment.enrolledModules.some((em) => em.module.toString() === moduleId)
}

async function updateLessonProgress(userId, courseId, moduleId, lessonId, quizId = null) {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const progress = await Progress.findOne({
      user: userId,
      course: courseId,
      module: moduleId,
    }).session(session)

    if (!progress) {
      await Progress.create(
        [
          {
            user: userId,
            course: courseId,
            module: moduleId,
            completedLessons: [lessonId],
            completedQuizzes: quizId ? [quizId] : [],
            lastAccessed: new Date(),
          },
        ],
        { session }
      )
    } else {
      if (!progress.completedLessons.includes(lessonId)) {
        progress.completedLessons.push(lessonId)
      }
      if (quizId && !progress.completedQuizzes.includes(quizId)) {
        progress.completedQuizzes.push(quizId)
      }
      progress.lastAccessed = new Date()

      // Update progress percentage
      const totalLessons = await Lesson.countDocuments({
        module: moduleId,
        isDeleted: false,
      }).session(session)

      progress.progress = (progress.completedLessons.length / totalLessons) * 100
      await progress.save({ session })
    }

    await session.commitTransaction()
  } catch (error) {
    await session.abortTransaction()
    throw error
  } finally {
    session.endSession()
  }
}

async function checkPrerequisites(moduleId, userId) {
  const module = await Module.findById(moduleId).populate('prerequisites')

  if (!module.prerequisites?.length) return true

  const progressPromises = module.prerequisites.map(async (prereq) => {
    const progress = await Progress.findOne({
      user: userId,
      module: prereq._id,
    })

    if (!progress) return false

    const dependency = module.dependencies?.find((d) => d.module.toString() === prereq._id.toString())
    const requiredCompletion = dependency?.requiredCompletion || 100

    return progress.progress >= requiredCompletion
  })

  const results = await Promise.all(progressPromises)
  return results.every((result) => result)
}

// Helper function to handle video upload cleanup
async function cleanupVideo(cloudflareVideoId) {
  if (cloudflareVideoId) {
    try {
      await CloudflareService.deleteVideo(cloudflareVideoId)
    } catch (error) {
      console.error('Error cleaning up video:', error)
    }
  }
}
exports.createLesson = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = lessonSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const moduleId = req.params.moduleId
    const module = await Module.findById(moduleId).session(session)

    if (!module) {
      await session.abortTransaction()
      return next(new AppError('Module not found', 404))
    }

    // Check if order number is already taken
    const existingLesson = await Lesson.findOne({
      module: moduleId,
      order: value.order,
      isDeleted: false,
    }).session(session)

    if (existingLesson) {
      await session.abortTransaction()
      return next(new AppError('A lesson with this order number already exists', 400))
    }

    const lesson = await Lesson.create(
      [
        {
          ...value,
          module: moduleId,
        },
      ],
      { session }
    )

    await session.commitTransaction()

    const populatedLesson = await Lesson.findById(lesson[0]._id).populate({
      path: 'quiz',
      select: 'title type passingScore',
    })

    res.status(201).json({
      status: 'success',
      data: populatedLesson,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getLessons = async (req, res, next) => {
  try {
    const moduleId = req.params.moduleId
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lessons = await Lesson.find({
      module: moduleId,
      isDeleted: false,
    })
      .sort('order')
      .populate({
        path: 'quiz',
        select: 'title type passingScore',
      })

    const progress = await Progress.findOne({
      user: req.user._id,
      module: moduleId,
    })

    const lessonsWithProgress = lessons.map((lesson) => {
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
      data: lessonsWithProgress,
    })
  } catch (error) {
    next(error)
  }
}

exports.getLesson = async (req, res, next) => {
  try {
    const moduleId = req.params.moduleId
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate({
      path: 'quiz',
      select: 'title type passingScore',
    })

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    // Check prerequisites for this lesson's module
    const prerequisitesMet = await checkPrerequisites(moduleId, req.user._id)
    if (!prerequisitesMet) {
      return next(new AppError('Module prerequisites not met', 403))
    }

    const progress = await Progress.findOne({
      user: req.user._id,
      module: moduleId,
    })

    const lessonObj = lesson.toObject()
    if (progress) {
      lessonObj.completed = progress.completedLessons.includes(lesson._id)
      if (lesson.quiz) {
        lessonObj.quiz.completed = progress.completedQuizzes.includes(lesson.quiz._id)
      }

      // Get previous lesson's completion status if this lesson requires quiz pass
      if (lesson.requireQuizPass && lesson.order > 1) {
        const prevLesson = await Lesson.findOne({
          module: moduleId,
          order: lesson.order - 1,
          isDeleted: false,
        }).populate('quiz')

        if (prevLesson) {
          lessonObj.previousLessonCompleted = progress.completedLessons.includes(prevLesson._id)
          lessonObj.previousQuizCompleted = prevLesson.quiz ? progress.completedQuizzes.includes(prevLesson.quiz._id) : true
        }
      }
    }

    res.status(200).json({
      status: 'success',
      data: lessonObj,
    })
  } catch (error) {
    next(error)
  }
}

exports.updateLesson = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = updateLessonSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    if (value.order) {
      const existingLesson = await Lesson.findOne({
        module: req.params.moduleId,
        order: value.order,
        _id: { $ne: req.params.lessonId },
        isDeleted: false,
      }).session(session)

      if (existingLesson) {
        await session.abortTransaction()
        return next(new AppError('A lesson with this order number already exists', 400))
      }
    }

    const lesson = await Lesson.findOneAndUpdate(
      {
        _id: req.params.lessonId,
        module: req.params.moduleId,
        isDeleted: false,
      },
      value,
      {
        new: true,
        runValidators: true,
        session,
      }
    ).populate({
      path: 'quiz',
      select: 'title type passingScore',
    })

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: lesson,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.deleteLesson = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    // Check if any students have completed this lesson
    const hasCompletions = await Progress.exists({
      module: req.params.moduleId,
      completedLessons: lesson._id,
    }).session(session)

    if (hasCompletions) {
      // Soft delete if there are completions
      lesson.isDeleted = true
      await lesson.save({ session })

      // Also soft delete associated quiz if exists
      if (lesson.quiz) {
        await Quiz.findByIdAndUpdate(lesson.quiz, { isDeleted: true }, { session })
      }
    } else {
      // Hard delete if no completions
      await Promise.all([Lesson.deleteOne({ _id: lesson._id }).session(session), Quiz.deleteOne({ lesson: lesson._id }).session(session)])

      // Delete video from Cloudflare if exists
      if (lesson.cloudflareVideoId) {
        await cleanupVideo(lesson.cloudflareVideoId)
      }

      // Update order of remaining lessons
      await Lesson.updateMany(
        {
          module: req.params.moduleId,
          order: { $gt: lesson.order },
        },
        { $inc: { order: -1 } },
        { session }
      )
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Lesson deleted successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.uploadLessonVideo = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    if (!req.file) {
      return next(new AppError('Please provide a video file', 400))
    }

    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    // Delete existing video if any
    if (lesson.cloudflareVideoId) {
      await cleanupVideo(lesson.cloudflareVideoId)
    }

    // Get upload URL from Cloudflare
    const { uploadUrl, videoId } = await CloudflareService.getUploadUrl()

    // Upload video to Cloudflare
    const formData = new FormData()
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    })

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    })

    if (!uploadResponse.ok) {
      await session.abortTransaction()
      return next(new AppError('Failed to upload video', 500))
    }

    // Get video details
    const videoDetails = await CloudflareService.getVideoDetails(videoId)

    // Update lesson with video details
    lesson.videoUrl = videoDetails.playbackUrl
    lesson.cloudflareVideoId = videoId
    lesson.duration = Math.round(videoDetails.duration)
    await lesson.save({ session })

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        videoUrl: lesson.videoUrl,
        duration: lesson.duration,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.deleteLessonVideo = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    if (!lesson.cloudflareVideoId) {
      await session.abortTransaction()
      return next(new AppError('No video found for this lesson', 404))
    }

    // Delete video from Cloudflare
    await cleanupVideo(lesson.cloudflareVideoId)

    // Update lesson
    lesson.videoUrl = undefined
    lesson.cloudflareVideoId = undefined
    lesson.duration = undefined
    await lesson.save({ session })

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Video deleted successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getVideoStreamUrl = async (req, res, next) => {
  try {
    const moduleId = req.params.moduleId
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: moduleId,
      isDeleted: false,
    })

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    if (!lesson.cloudflareVideoId) {
      return next(new AppError('No video found for this lesson', 404))
    }

    // Check prerequisites
    const prerequisitesMet = await checkPrerequisites(moduleId, req.user._id)
    if (!prerequisitesMet) {
      return next(new AppError('Module prerequisites not met', 403))
    }

    // Check if previous lesson's quiz is completed if required
    if (lesson.requireQuizPass && lesson.order > 1) {
      const prevLesson = await Lesson.findOne({
        module: moduleId,
        order: lesson.order - 1,
        isDeleted: false,
      }).populate('quiz')

      if (prevLesson && prevLesson.quiz) {
        const progress = await Progress.findOne({
          user: req.user._id,
          module: moduleId,
        })

        if (!progress?.completedQuizzes.includes(prevLesson.quiz._id)) {
          return next(new AppError("Previous lesson's quiz must be completed first", 403))
        }
      }
    }

    // Get latest video details from Cloudflare
    const videoDetails = await CloudflareService.getVideoDetails(lesson.cloudflareVideoId)

    res.status(200).json({
      status: 'success',
      data: {
        streamUrl: videoDetails.playbackUrl,
        duration: videoDetails.duration,
        thumbnail: videoDetails.thumbnail,
      },
    })
  } catch (error) {
    next(error)
  }
}

exports.markLessonComplete = async (req, res, next) => {
  try {
    const moduleId = req.params.moduleId
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate('quiz')

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    // Check prerequisites
    const prerequisitesMet = await checkPrerequisites(moduleId, req.user._id)
    if (!prerequisitesMet) {
      return next(new AppError('Module prerequisites not met', 403))
    }

    // If quiz is required, check if it's completed
    if (lesson.quiz && lesson.requireQuizPass) {
      const progress = await Progress.findOne({
        user: req.user._id,
        module: moduleId,
      })

      if (!progress?.completedQuizzes.includes(lesson.quiz._id)) {
        return next(new AppError('Quiz must be completed first', 403))
      }
    }

    // Update progress
    await updateLessonProgress(req.user._id, req.params.courseId, moduleId, lesson._id)

    res.status(200).json({
      status: 'success',
      message: 'Lesson marked as completed',
    })
  } catch (error) {
    next(error)
  }
}

exports.getLessonProgress = async (req, res, next) => {
  try {
    const moduleId = req.params.moduleId
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate('quiz')

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    const progress = await Progress.findOne({
      user: req.user._id,
      module: moduleId,
    })

    const progressData = {
      completed: progress?.completedLessons.includes(lesson._id) || false,
      quizCompleted: lesson.quiz ? progress?.completedQuizzes.includes(lesson.quiz._id) || false : null,
      lastAccessed: progress?.lastAccessed,
    }

    // Get next lesson if available
    const nextLesson = await Lesson.findOne({
      module: moduleId,
      order: lesson.order + 1,
      isDeleted: false,
    }).select('_id title requireQuizPass')

    if (nextLesson) {
      progressData.nextLesson = {
        id: nextLesson._id,
        title: nextLesson.title,
        requireQuizPass: nextLesson.requireQuizPass,
        accessible: !nextLesson.requireQuizPass || (lesson.quiz ? progress?.completedQuizzes.includes(lesson.quiz._id) : true),
      }
    }

    res.status(200).json({
      status: 'success',
      data: progressData,
    })
  } catch (error) {
    next(error)
  }
}

exports.reorderLessons = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { error, value } = reorderSchema.validate(req.body)
    if (error) {
      return res.status(400).json({
        status: 'error',
        errors: error.details.map((detail) => ({
          field: detail.context.key,
          message: detail.message,
        })),
      })
    }

    const { lessonOrders } = value

    // Verify all lessons exist and belong to the module
    const lessons = await Lesson.find({
      _id: { $in: lessonOrders.map((lo) => lo.lessonId) },
      module: req.params.moduleId,
      isDeleted: false,
    }).session(session)

    if (lessons.length !== lessonOrders.length) {
      await session.abortTransaction()
      return next(new AppError('One or more lessons not found', 404))
    }

    // Check for duplicate order numbers
    const orders = lessonOrders.map((lo) => lo.order)
    if (new Set(orders).size !== orders.length) {
      await session.abortTransaction()
      return next(new AppError('Duplicate order numbers not allowed', 400))
    }

    // Update lesson orders
    await Promise.all(lessonOrders.map((lo) => Lesson.findByIdAndUpdate(lo.lessonId, { order: lo.order }, { session })))

    await session.commitTransaction()

    const updatedLessons = await Lesson.find({
      module: req.params.moduleId,
      isDeleted: false,
    })
      .sort('order')
      .populate('quiz')

    res.status(200).json({
      status: 'success',
      data: updatedLessons,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

exports.getLessonQuiz = async (req, res, next) => {
  try {
    const moduleId = req.params.moduleId
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate({
      path: 'quiz',
      match: { isDeleted: false },
      select: '-questions.correctAnswer', // Hide correct answers
    })

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    if (!lesson.quiz) {
      return next(new AppError('No quiz found for this lesson', 404))
    }

    const progress = await Progress.findOne({
      user: req.user._id,
      module: moduleId,
    })

    const quizData = lesson.quiz.toObject()
    quizData.completed = progress?.completedQuizzes.includes(lesson.quiz._id) || false

    res.status(200).json({
      status: 'success',
      data: quizData,
    })
  } catch (error) {
    next(error)
  }
}