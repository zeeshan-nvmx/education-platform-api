const Joi = require('joi')
const mongoose = require('mongoose')
const { Lesson, Module, Progress, Quiz, User } = require('../models')
const { AppError } = require('../utils/errors')
const CloudflareService = require('../utils/cloudflare')

// Validation Schemas
const lessonSchema = Joi.object({
  title: Joi.string().required().trim(),
  description: Joi.string().allow('').trim(),
  order: Joi.number().integer().min(1).required(),
  requireQuizPass: Joi.boolean().default(false),
}).options({ abortEarly: false })

const updateLessonSchema = Joi.object({
  title: Joi.string().trim(),
  description: Joi.string().allow('').trim(),
  order: Joi.number().integer().min(1),
  requireQuizPass: Joi.boolean(),
}).options({ abortEarly: false })

const reorderSchema = Joi.object({
  lessonOrders: Joi.array()
    .items(
      Joi.object({
        lessonId: Joi.string().regex(/^[0-9a-fA-F]{24}$/),
        order: Joi.number().integer().min(1),
      })
    )
    .required()
    .min(1),
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

async function updateProgress(userId, courseId, moduleId, lessonId, quizId = null) {
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

// Helper function to handle video cleanup
async function cleanupVideo(cloudflareVideoId) {
  if (cloudflareVideoId) {
    try {
      await CloudflareService.deleteVideo(cloudflareVideoId)
    } catch (error) {
      console.error('Error cleaning up video:', error)
    }
  }
}

// Create Lesson
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

    // Check if module exists
    const module = await Module.findOne({
      _id: req.params.moduleId,
      course: req.params.courseId,
      isDeleted: false,
    }).session(session)

    if (!module) {
      await session.abortTransaction()
      return next(new AppError('Module not found', 404))
    }

    // Check for duplicate order
    const existingLesson = await Lesson.findOne({
      module: req.params.moduleId,
      order: value.order,
      isDeleted: false,
    }).session(session)

    if (existingLesson) {
      await session.abortTransaction()
      return next(new AppError('A lesson with this order number already exists', 400))
    }

    // Create the lesson
    const lesson = await Lesson.create(
      [
        {
          ...value,
          module: req.params.moduleId,
        },
      ],
      { session }
    )

    await session.commitTransaction()

    // Fetch the created lesson with populated fields
    const populatedLesson = await Lesson.findById(lesson[0]._id).populate({
      path: 'quiz',
      select: 'title type passingScore',
      match: { isDeleted: false },
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

// Get All Lessons
exports.getLessons = async (req, res, next) => {
  try {
    // Check module access
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, req.params.moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    // Get lessons with quiz information
    const lessons = await Lesson.find({
      module: req.params.moduleId,
      isDeleted: false,
    })
      .sort('order')
      .populate({
        path: 'quiz',
        select: 'title type passingScore',
        match: { isDeleted: false },
      })

    // Get progress if it exists
    const progress = await Progress.findOne({
      user: req.user._id,
      module: req.params.moduleId,
    })

    // Add progress information to lessons
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

// Get Single Lesson
exports.getLesson = async (req, res, next) => {
  try {
    // Check module access
    const hasAccess = await checkModuleAccess(req.user._id, req.params.courseId, req.params.moduleId)

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    // Get lesson with quiz
    const lesson = await Lesson.findOne({
      _id: req.params.lessonId,
      module: req.params.moduleId,
      isDeleted: false,
    }).populate({
      path: 'quiz',
      select: 'title type passingScore',
      match: { isDeleted: false },
    })

    if (!lesson) {
      return next(new AppError('Lesson not found', 404))
    }

    // Check prerequisites
    const prerequisitesMet = await checkPrerequisites(req.params.moduleId, req.user._id)
    if (!prerequisitesMet) {
      return next(new AppError('Module prerequisites not met', 403))
    }

    // Get progress information
    const progress = await Progress.findOne({
      user: req.user._id,
      module: req.params.moduleId,
    })

    const lessonObj = lesson.toObject()
    if (progress) {
      lessonObj.completed = progress.completedLessons.includes(lesson._id)
      if (lesson.quiz) {
        lessonObj.quiz.completed = progress.completedQuizzes.includes(lesson.quiz._id)
      }

      // Get previous lesson's completion status if quiz is required
      if (lesson.requireQuizPass && lesson.order > 1) {
        const prevLesson = await Lesson.findOne({
          module: req.params.moduleId,
          order: lesson.order - 1,
          isDeleted: false,
        }).populate({
          path: 'quiz',
          match: { isDeleted: false },
        })

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

// Update Lesson
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

    // Check for duplicate order if order is being updated
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

    // Update the lesson
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
      match: { isDeleted: false },
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

// Delete Lesson
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

      // Soft delete associated quiz if exists
      if (lesson.quiz) {
        await Quiz.findByIdAndUpdate(lesson.quiz, { isDeleted: true }, { session })
      }
    } else {
      // Hard delete if no completions
      await Promise.all([Lesson.deleteOne({ _id: lesson._id }).session(session), Quiz.deleteOne({ lesson: lesson._id }).session(session)])

      // Delete video if exists
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

// Video Management Functions
// exports.uploadLessonVideo = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     if (!req.file) {
//       return next(new AppError('Please provide a video file', 400))
//     }

//     const lesson = await Lesson.findOne({
//       _id: req.params.lessonId,
//       module: req.params.moduleId,
//       isDeleted: false,
//     }).session(session)

//     if (!lesson) {
//       await session.abortTransaction()
//       return next(new AppError('Lesson not found', 404))
//     }

//     // Delete existing video if any
//     if (lesson.cloudflareVideoId) {
//       await cleanupVideo(lesson.cloudflareVideoId)
//     }

//     try {
//       // Get upload URL from Cloudflare
//       const { uploadUrl, videoId } = await CloudflareService.getUploadUrl()

//       // Upload video to Cloudflare
//       const formData = new FormData()
//       formData.append('file', req.file.buffer, {
//         filename: req.file.originalname,
//         contentType: req.file.mimetype,
//       })

//       const uploadResponse = await fetch(uploadUrl, {
//         method: 'POST',
//         body: formData,
//       })

//       if (!uploadResponse.ok) {
//         throw new Error('Failed to upload video to Cloudflare')
//       }

//       // Get video details
//       const videoDetails = await CloudflareService.getVideoDetails(videoId)

//       // Update lesson with video details
//       lesson.videoUrl = videoDetails.playbackUrl
//       lesson.cloudflareVideoId = videoId
//       lesson.duration = Math.round(videoDetails.duration)
//       await lesson.save({ session })

//       await session.commitTransaction()

//       res.status(200).json({
//         status: 'success',
//         data: {
//           videoUrl: lesson.videoUrl,
//           duration: lesson.duration,
//         },
//       })
//     } catch (error) {
//       if (lesson.cloudflareVideoId) {
//         await cleanupVideo(lesson.cloudflareVideoId)
//       }
//       throw error
//     }
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

exports.uploadLessonVideo = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    if (!req.file) {
      return next(new AppError('Please provide a video file', 400))
    }

    // Check file size (e.g., 200MB limit)
    const maxSize = 200 * 1024 * 1024 // 200MB in bytes
    if (req.file.size > maxSize) {
      return next(new AppError('Video file too large. Maximum size is 200MB', 400))
    }

    // Check file type
    if (!req.file.mimetype.startsWith('video/')) {
      return next(new AppError('Please upload only video files', 400))
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

    // If there's an existing video, try to delete it
    if (lesson.cloudflareVideoId) {
      try {
        await CloudflareService.deleteVideo(lesson.cloudflareVideoId)
      } catch (error) {
        // Log the error but continue with the upload
        console.error('Error deleting existing video:', error)
      }
    }

    // Upload new video
    try {
      const { videoId, videoDetails } = await CloudflareService.uploadVideo(req.file)

      // Update lesson with all video details
      lesson.videoUrl = videoDetails.playbackUrl
      lesson.dashUrl = videoDetails.dashUrl
      lesson.rawUrl = videoDetails.rawUrl
      lesson.cloudflareVideoId = videoId
      lesson.duration = videoDetails.duration || 0
      lesson.thumbnail = videoDetails.thumbnail
      lesson.videoMeta = {
        size: videoDetails.meta.size,
        created: videoDetails.meta.created,
        modified: videoDetails.meta.modified,
        status: videoDetails.meta.status,
      }

      await lesson.save({ session })
      await session.commitTransaction()

      res.status(200).json({
        message: 'Video uploaded successfully',
        data: {
          videoUrl: lesson.videoUrl,
          dashUrl: lesson.dashUrl,
          rawUrl: lesson.rawUrl,
          duration: lesson.duration,
          thumbnail: lesson.thumbnail,
          videoMeta: lesson.videoMeta,
        },
      })
    } catch (uploadError) {
      console.error('Error during video upload:', uploadError)
      await session.abortTransaction()
      return next(new AppError('Failed to upload video. Please try again.', 500))
    }
  } catch (error) {
    console.error('Error in uploadLessonVideo:', error)
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

    try {
      await CloudflareService.deleteVideo(lesson.cloudflareVideoId)
    } catch (error) {
      // If video doesn't exist in Cloudflare, continue with database cleanup
      if (!error.message.includes('not found')) {
        throw error
      }
    }

    // Clear all video-related fields
    lesson.videoUrl = undefined
    lesson.dashUrl = undefined
    lesson.rawUrl = undefined
    lesson.cloudflareVideoId = undefined
    lesson.duration = undefined
    lesson.thumbnail = undefined
    lesson.videoMeta = undefined

    await lesson.save({ session })
    await session.commitTransaction()

    res.status(200).json({
      message: 'Video deleted successfully',
    })
  } catch (error) {
    console.error('Error in deleteLessonVideo:', error)
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

    // Get video details from Cloudflare
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

// Progress and Quiz Functions
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
    await updateProgress(req.user._id, req.params.courseId, moduleId, lesson._id)

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

// Lesson Reordering
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
