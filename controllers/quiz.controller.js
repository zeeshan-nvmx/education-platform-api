const mongoose = require('mongoose')
const { Quiz, QuizAttempt, Lesson, Progress, User, LessonProgress, VideoProgress, AssetProgress } = require('../models')
const { AppError } = require('../utils/errors')

// Create a new quiz
// exports.createQuiz = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     const { courseId, moduleId, lessonId } = req.params
//     const { title, quizTime, passingScore, questions, maxAttempts = 3 } = req.body

//     // Validate lesson exists
//     const lesson = await Lesson.findOne({
//       _id: lessonId,
//       module: moduleId,
//       isDeleted: false,
//     }).session(session)

//     if (!lesson) {
//       await session.abortTransaction()
//       return next(new AppError('Lesson not found', 404))
//     }

//     // Check if quiz already exists
//     if (lesson.quiz) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz already exists for this lesson', 400))
//     }

//     // Calculate totalMarks from questions
//     const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0)

//     // Create quiz
//     const quiz = await Quiz.create(
//       [
//         {
//           lesson: lessonId,
//           title,
//           quizTime,
//           passingScore,
//           maxAttempts,
//           totalMarks,
//           questions: questions.map((q) => ({
//             question: q.question,
//             type: q.options ? 'mcq' : 'text',
//             options: q.options,
//             marks: q.marks || 1,
//           })),
//         },
//       ],
//       { session }
//     )

//     // Update lesson with quiz reference and quiz settings
//     lesson.quiz = quiz[0]._id
//     lesson.quizSettings = {
//       required: true, // Since a quiz is being created
//       minimumPassingScore: passingScore,
//       allowReview: true,
//       blockProgress: true,
//       showQuizAt: 'after',
//       minimumTimeRequired: 0,
//     }

//     await lesson.save({ session })

//     await session.commitTransaction()

//     res.status(201).json({
//       status: 'success',
//       message: 'Quiz created successfully',
//       data: quiz[0],
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

exports.createQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params
    const { title, quizTime, passingScore, questions, maxAttempts = 3, questionPoolSize = 0 } = req.body

    // Validate lesson exists
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    // Check if quiz already exists
    if (lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz already exists for this lesson', 400))
    }

    // Validate questionPoolSize
    if (questionPoolSize > questions.length) {
      await session.abortTransaction()
      return next(new AppError('Question pool size cannot exceed total number of questions', 400))
    }

    // Calculate totalMarks from questions
    const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0)

    // Create quiz
    const quiz = await Quiz.create(
      [
        {
          lesson: lessonId,
          title,
          quizTime,
          passingScore,
          maxAttempts,
          questionPoolSize,
          totalMarks,
          questions: questions.map((q) => ({
            question: q.question,
            type: q.options ? 'mcq' : 'text',
            options: q.options,
            marks: q.marks || 1,
          })),
        },
      ],
      { session }
    )

    // Update lesson with quiz reference and quiz settings
    lesson.quiz = quiz[0]._id
    lesson.quizSettings = {
      required: true, // Since a quiz is being created
      minimumPassingScore: passingScore,
      allowReview: true,
      blockProgress: true,
      showQuizAt: 'after',
      minimumTimeRequired: 0,
    }

    await lesson.save({ session })

    await session.commitTransaction()

    res.status(201).json({
      status: 'success',
      message: 'Quiz created successfully',
      data: quiz[0],
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// // Update a quiz
// exports.updateQuiz = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     const { courseId, moduleId, lessonId } = req.params
//     const { title, quizTime, passingScore, questions, maxAttempts, questionPoolSize } = req.body

//     // Validate lesson exists and has a quiz
//     const lesson = await Lesson.findOne({
//       _id: lessonId,
//       module: moduleId,
//       isDeleted: false,
//     })
//       .populate('quiz')
//       .session(session)

//     if (!lesson) {
//       await session.abortTransaction()
//       return next(new AppError('Lesson not found', 404))
//     }

//     if (!lesson.quiz) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz not found for this lesson', 404))
//     }

//     const quiz = lesson.quiz

//     // Check if there are existing attempts - if so, restrict certain changes
//     const hasAttempts = await QuizAttempt.exists({ quiz: quiz._id }).session(session)

//     // Allow updating basic info regardless of attempts
//     const updateData = {}
//     if (title) updateData.title = title
//     if (quizTime) updateData.quizTime = quizTime
//     if (passingScore) updateData.passingScore = passingScore
//     if (maxAttempts) updateData.maxAttempts = maxAttempts
//     if (questionPoolSize !== undefined) {
//       // If updating both questions and pool size
//       if (questions && !hasAttempts) {
//         if (questionPoolSize > questions.length) {
//           await session.abortTransaction()
//           return next(new AppError('Question pool size cannot exceed total number of questions', 400))
//         }
//         updateData.questionPoolSize = questionPoolSize
//       }
//       // If only updating pool size (check against existing questions)
//       else if (!questions) {
//         if (questionPoolSize > quiz.questions.length) {
//           await session.abortTransaction()
//           return next(new AppError('Question pool size cannot exceed total number of questions', 400))
//         }
//         updateData.questionPoolSize = questionPoolSize
//       }
//     }

//     // Only update questions if there are no attempts
//     if (questions && !hasAttempts) {
//       updateData.questions = questions.map((q) => ({
//         question: q.question,
//         type: q.options ? 'mcq' : 'text',
//         options: q.options,
//         marks: q.marks || 1,
//       }))

//       // Recalculate totalMarks
//       updateData.totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0)
//     } else if (questions && hasAttempts) {
//       await session.abortTransaction()
//       return next(new AppError('Cannot modify quiz questions when there are existing attempts', 400))
//     }

//     // Update the quiz
//     const updatedQuiz = await Quiz.findByIdAndUpdate(quiz._id, updateData, { new: true, runValidators: true, session })

//     // Update lesson quiz settings if necessary
//     if (passingScore) {
//       lesson.quizSettings.minimumPassingScore = passingScore
//       await lesson.save({ session })
//     }

//     await session.commitTransaction()

//     res.status(200).json({
//       status: 'success',
//       message: 'Quiz updated successfully',
//       data: updatedQuiz,
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

// Update a quiz - Allow admins to update everything regardless of attempts
exports.updateQuiz = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { courseId, moduleId, lessonId } = req.params;
    const { title, quizTime, passingScore, questions, maxAttempts, questionPoolSize } = req.body;

    // Validate lesson exists and has a quiz
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).populate('quiz').session(session);

    if (!lesson) {
      await session.abortTransaction();
      return next(new AppError('Lesson not found', 404));
    }

    if (!lesson.quiz) {
      await session.abortTransaction();
      return next(new AppError('Quiz not found for this lesson', 404));
    }

    const quiz = lesson.quiz;

    // Create update data object with all fields that are provided
    const updateData = {};
    if (title) updateData.title = title;
    if (quizTime) updateData.quizTime = quizTime;
    if (passingScore) updateData.passingScore = passingScore;
    if (maxAttempts) updateData.maxAttempts = maxAttempts;
    
    // Update questions if provided
    if (questions) {
      updateData.questions = questions.map(q => ({
        question: q.question,
        type: q.options ? 'mcq' : 'text',
        options: q.options,
        marks: q.marks || 1
      }));
      
      // Recalculate totalMarks
      updateData.totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
    }

    // Update questionPoolSize if provided
    if (questionPoolSize !== undefined) {
      // If updating both questions and pool size
      if (questions) {
        if (questionPoolSize > questions.length && questionPoolSize !== 0) {
          await session.abortTransaction();
          return next(new AppError('Question pool size cannot exceed total number of questions', 400));
        }
        updateData.questionPoolSize = questionPoolSize;
      } 
      // If only updating pool size (check against existing questions)
      else {
        if (questionPoolSize > quiz.questions.length && questionPoolSize !== 0) {
          await session.abortTransaction();
          return next(new AppError('Question pool size cannot exceed total number of questions', 400));
        }
        updateData.questionPoolSize = questionPoolSize;
      }
    }

    // Update the quiz
    const updatedQuiz = await Quiz.findByIdAndUpdate(
      quiz._id,
      updateData,
      { new: true, runValidators: true, session }
    );

    // Update lesson quiz settings if necessary
    if (passingScore) {
      lesson.quizSettings.minimumPassingScore = passingScore;
      await lesson.save({ session });
    }

    await session.commitTransaction();

    res.status(200).json({
      status: 'success',
      message: 'Quiz updated successfully',
      data: updatedQuiz
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
};

// Delete a quiz
exports.deleteQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params

    // Validate lesson exists and has a quiz
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    }).session(session)

    if (!lesson) {
      await session.abortTransaction()
      return next(new AppError('Lesson not found', 404))
    }

    if (!lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found for this lesson', 404))
    }

    const quizId = lesson.quiz

    // Check if there are existing attempts
    const hasAttempts = await QuizAttempt.exists({ quiz: quizId }).session(session)

    if (hasAttempts) {
      // Soft delete - mark quiz as deleted but keep the data
      await Quiz.findByIdAndUpdate(quizId, { isDeleted: true }, { session })
    } else {
      // Hard delete - remove the quiz completely
      await Quiz.findByIdAndDelete(quizId, { session })
    }

    // Always remove the quiz reference from the lesson
    lesson.quiz = undefined
    lesson.quizSettings = {
      required: false,
      minimumPassingScore: 70,
      allowReview: true,
      blockProgress: false,
      showQuizAt: 'after',
      minimumTimeRequired: 0,
    }
    await lesson.save({ session })

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Quiz deleted successfully',
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Get quiz details
// exports.getQuiz = async (req, res, next) => {
//   try {
//     const { courseId, moduleId, lessonId } = req.params
//     const userId = req.user._id

//     // Check user has access to this module/course - simplified check
//     const user = await User.findById(userId).select('+role +enrolledCourses').lean()

//     if (!user) {
//       return next(new AppError('User not found', 404))
//     }

//     const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
//     let hasAccess = isAdmin

//     if (!isAdmin) {
//       const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
//       hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
//     }

//     if (!hasAccess) {
//       return next(new AppError('You do not have access to this module', 403))
//     }

//     const lesson = await Lesson.findOne({
//       _id: lessonId,
//       module: moduleId,
//       isDeleted: false,
//     }).populate({
//       path: 'quiz',
//       match: { isDeleted: false },
//     })

//     if (!lesson || !lesson.quiz) {
//       return next(new AppError('Quiz not found', 404))
//     }

//     const quiz = lesson.quiz

//     // Check if user can take quiz based on requirements
//     let canTakeQuiz = true

//     // // Time requirement check
//     // if (lesson.quizSettings?.minimumTimeRequired > 0) {
//     //   const timeProgress = await LessonProgress.findOne({
//     //     user: userId,
//     //     lesson: lessonId,
//     //   })

//     //   if (!timeProgress || timeProgress.timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
//     //     canTakeQuiz = false
//     //   }
//     // }

//     // // Video completion check if required
//     // if (canTakeQuiz && lesson.quizSettings?.showQuizAt === 'after' && lesson.videoUrl) {
//     //   const videoProgress = await VideoProgress.findOne({
//     //     user: userId,
//     //     lesson: lessonId,
//     //   })

//     //   if (!videoProgress?.completed) {
//     //     canTakeQuiz = false
//     //   }
//     // }

//     // // Required asset downloads check
//     // if (canTakeQuiz && lesson.completionRequirements?.downloadAssets?.length > 0) {
//     //   const requiredAssets = lesson.completionRequirements.downloadAssets.filter((asset) => asset.required)

//     //   if (requiredAssets.length > 0) {
//     //     const downloadCount = await AssetProgress.countDocuments({
//     //       user: userId,
//     //       lesson: lessonId,
//     //       asset: { $in: requiredAssets.map((a) => a.assetId) },
//     //     })

//     //     if (downloadCount < requiredAssets.length) {
//     //       canTakeQuiz = false
//     //     }
//     //   }
//     // }

//     // Get user's previous attempts
//     const attempts = await QuizAttempt.find({
//       quiz: quiz._id,
//       user: userId,
//     }).sort('-createdAt')

//     // Check if user can take new attempt
//     const canStartNewAttempt = canTakeQuiz && attempts.length < quiz.maxAttempts

//     res.status(200).json({
//       status: 'success',
//       data: {
//         quiz: {
//           _id: quiz._id,
//           title: quiz.title,
//           quizTime: quiz.quizTime,
//           passingScore: quiz.passingScore,
//           maxAttempts: quiz.maxAttempts,
//           totalMarks: quiz.totalMarks,
//           questionCount: quiz.questions.length,
//         },
//         attempts: attempts.map((attempt) => ({
//           _id: attempt._id,
//           score: attempt.score,
//           percentage: attempt.percentage,
//           status: attempt.status,
//           startTime: attempt.startTime,
//           submitTime: attempt.submitTime,
//         })),
//         canTakeQuiz,
//         canStartNewAttempt,
//         requirements: lesson.quizSettings,
//       },
//     })
//   } catch (error) {
//     next(error)
//   }
// }

// Get quiz details
exports.getQuiz = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId } = req.params;
    const userId = req.user._id;

    // Check user has access to this module/course - simplified check
    const user = await User.findById(userId).select('+role +enrolledCourses').lean();
    
    if (!user) {
      return next(new AppError('User not found', 404));
    }
    
    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role);
    let hasAccess = isAdmin;
    
    if (!isAdmin) {
      const enrolledCourse = user.enrolledCourses?.find(ec => ec.course.toString() === courseId);
      hasAccess = enrolledCourse && (
        enrolledCourse.enrollmentType === 'full' || 
        enrolledCourse.enrolledModules.some(em => em.module.toString() === moduleId)
      );
    }
    
    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403));
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false
    }).populate({
      path: 'quiz',
      match: { isDeleted: false }
    });

    if (!lesson || !lesson.quiz) {
      return next(new AppError('Quiz not found', 404));
    }

    const quiz = lesson.quiz;

    // Different response based on user role
    if (isAdmin) {
      // For admin users, return full quiz data including all questions and correct answers
      return res.status(200).json({
        status: 'success',
        data: {
          quiz: {
            _id: quiz._id,
            title: quiz.title,
            quizTime: quiz.quizTime,
            passingScore: quiz.passingScore,
            maxAttempts: quiz.maxAttempts,
            totalMarks: quiz.totalMarks,
            questions: quiz.questions, // Include full questions with correct answers
            createdAt: quiz.createdAt,
            updatedAt: quiz.updatedAt
          },
          attemptCount: await QuizAttempt.countDocuments({ quiz: quiz._id }),
          pendingGrading: await QuizAttempt.countDocuments({ quiz: quiz._id, status: 'submitted' })
        }
      });
    }

    // For regular users, check if they can take quiz
    let canTakeQuiz = true;
    
    // Time requirement check
    if (lesson.quizSettings?.minimumTimeRequired > 0) {
      const timeProgress = await LessonProgress.findOne({
        user: userId,
        lesson: lessonId
      });
      
      if (!timeProgress || timeProgress.timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
        canTakeQuiz = false;
      }
    }
    
    // Video completion check if required
    if (canTakeQuiz && lesson.quizSettings?.showQuizAt === 'after' && lesson.videoUrl) {
      const videoProgress = await VideoProgress.findOne({
        user: userId,
        lesson: lessonId
      });
      
      if (!videoProgress?.completed) {
        canTakeQuiz = false;
      }
    }
    
    // Required asset downloads check
    if (canTakeQuiz && lesson.completionRequirements?.downloadAssets?.length > 0) {
      const requiredAssets = lesson.completionRequirements.downloadAssets.filter(asset => asset.required);
      
      if (requiredAssets.length > 0) {
        const downloadCount = await AssetProgress.countDocuments({
          user: userId,
          lesson: lessonId,
          asset: { $in: requiredAssets.map(a => a.assetId) }
        });
        
        if (downloadCount < requiredAssets.length) {
          canTakeQuiz = false;
        }
      }
    }

    // Get user's previous attempts
    const attempts = await QuizAttempt.find({
      quiz: quiz._id,
      user: userId
    }).sort('-createdAt');

    // Check if user can take new attempt
    const canStartNewAttempt = canTakeQuiz && attempts.length < quiz.maxAttempts;

    // Return regular user data
    res.status(200).json({
      status: 'success',
      data: {
        quiz: {
          _id: quiz._id,
          title: quiz.title,
          quizTime: quiz.quizTime,
          passingScore: quiz.passingScore,
          maxAttempts: quiz.maxAttempts,
          totalMarks: quiz.totalMarks,
          questionCount: quiz.questions.length
        },
        attempts: attempts.map(attempt => ({
          _id: attempt._id,
          score: attempt.score,
          percentage: attempt.percentage,
          status: attempt.status,
          startTime: attempt.startTime,
          submitTime: attempt.submitTime,
          passed: attempt.passed
        })),
        canTakeQuiz,
        canStartNewAttempt,
        requirements: lesson.quizSettings
      }
    });
  } catch (error) {
    next(error);
  }
}

// Start a new quiz attempt

// exports.startQuiz = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     const { courseId, moduleId, lessonId } = req.params
//     const userId = req.user._id

//     // Check user has access to this module/course - simplified check
//     const user = await User.findById(userId).select('+role +enrolledCourses').lean().session(session)

//     if (!user) {
//       await session.abortTransaction()
//       return next(new AppError('User not found', 404))
//     }

//     const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
//     let hasAccess = isAdmin

//     if (!isAdmin) {
//       const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
//       hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
//     }

//     if (!hasAccess) {
//       await session.abortTransaction()
//       return next(new AppError('You do not have access to this module', 403))
//     }

//     const lesson = await Lesson.findOne({
//       _id: lessonId,
//       module: moduleId,
//       isDeleted: false,
//     })
//       .populate({
//         path: 'quiz',
//         match: { isDeleted: false },
//       })
//       .session(session)

//     if (!lesson || !lesson.quiz) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz not found', 404))
//     }

//     const quiz = lesson.quiz

//     // // Check requirements
//     // let canTakeQuiz = true

//     // // Lesson video view or engagement Time requirement check
//     // if (lesson.quizSettings?.minimumTimeRequired > 0) {
//     //   const timeProgress = await LessonProgress.findOne({
//     //     user: userId,
//     //     lesson: lessonId,
//     //   }).session(session)

//     //   if (!timeProgress || timeProgress.timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
//     //     canTakeQuiz = false
//     //   }
//     // }

//     // if (!canTakeQuiz) {
//     //   await session.abortTransaction()
//     //   return next(new AppError('Quiz requirements not met', 403))
//     // }

//     // Check attempts limit
//     const attemptCount = await QuizAttempt.countDocuments({
//       quiz: quiz._id,
//       user: userId,
//       status: { $ne: 'inProgress' }, // Only count completed/graded attempts
//     }).session(session)

//     if (attemptCount >= quiz.maxAttempts) {
//       await session.abortTransaction()
//       return next(new AppError('Maximum attempts reached', 400))
//     }

//     // Check for ongoing attempt and handle expired attempts
//     const ongoingAttempt = await QuizAttempt.findOne({
//       quiz: quiz._id,
//       user: userId,
//       status: 'inProgress',
//     }).session(session)

//     if (ongoingAttempt) {
//       // Calculate if the attempt has expired based on quiz time
//       const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
//       const timeSinceStart = new Date() - ongoingAttempt.startTime

//       if (timeSinceStart > timeLimit) {
//         // The attempt has expired, so mark it as such
//         ongoingAttempt.status = 'submitted'
//         ongoingAttempt.submitTime = new Date(ongoingAttempt.startTime.getTime() + timeLimit)
//         ongoingAttempt.score = 0 // No score for expired/unsubmitted
//         ongoingAttempt.percentage = 0
//         ongoingAttempt.passed = false

//         // Save any answers that might have been recorded
//         await ongoingAttempt.save({ session })
//       } else {
//         // The attempt is still valid within the time window
//         await session.abortTransaction()
//         return next(new AppError('You have an ongoing quiz attempt', 400))
//       }
//     }

//     // Determine question set based on questionPoolSize
//     let questionSet = [...quiz.questions]
//     let selectedQuestionIds = []

//     // If questionPoolSize is set and less than total questions, select random subset
//     if (quiz.questionPoolSize > 0 && quiz.questionPoolSize < quiz.questions.length) {
//       // Shuffle questions array
//       questionSet = quiz.questions
//         .map((q) => ({ q, sort: Math.random() }))
//         .sort((a, b) => a.sort - b.sort)
//         .map(({ q }) => q)
//         .slice(0, quiz.questionPoolSize)
//     }

//     // Extract just the question IDs for storing in the attempt
//     selectedQuestionIds = questionSet.map((q) => q._id)

//     // Create new attempt with the selected question set
//     const attempt = await QuizAttempt.create(
//       [
//         {
//           quiz: quiz._id,
//           user: userId,
//           attempt: attemptCount + 1,
//           startTime: new Date(),
//           questionSet: selectedQuestionIds,
//         },
//       ],
//       { session }
//     )

//     // Prepare questions (remove correct answers for MCQs)
//     const questions = questionSet.map((q) => ({
//       _id: q._id,
//       question: q.question,
//       type: q.type,
//       marks: q.marks,
//       options:
//         q.type === 'mcq'
//           ? q.options.map((opt) => ({
//               _id: opt._id,
//               option: opt.option,
//             }))
//           : undefined,
//     }))

//     await session.commitTransaction()

//     // Calculate total marks for the selected questions
//     const attemptTotalMarks = questionSet.reduce((sum, q) => sum + q.marks, 0)

//     res.status(200).json({
//       status: 'success',
//       data: {
//         attemptId: attempt[0]._id,
//         questions,
//         questionCount: questions.length,
//         totalMarks: attemptTotalMarks,
//         quizTime: quiz.quizTime,
//         startTime: attempt[0].startTime,
//       },
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

// Start a new quiz attempt with improved error handling
exports.startQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params
    const userId = req.user._id

    // Check user has access to this module/course - simplified check
    const user = await User.findById(userId).select('+role +enrolledCourses').lean().session(session)

    if (!user) {
      await session.abortTransaction()
      return next(new AppError('User not found', 404))
    }

    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
    let hasAccess = isAdmin

    if (!isAdmin) {
      const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
      hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
    }

    if (!hasAccess) {
      await session.abortTransaction()
      return next(new AppError('You do not have access to this module', 403))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate({
        path: 'quiz',
        match: { isDeleted: false },
      })
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Skip all checks for admin users
    if (!isAdmin) {
      // Time requirement check - only if it's actually set (greater than 0)
      if (lesson.quizSettings?.minimumTimeRequired > 0) {
        const timeProgress = await LessonProgress.findOne({
          user: userId,
          lesson: lessonId,
        }).session(session)

        if (!timeProgress || timeProgress.timeSpent < lesson.quizSettings.minimumTimeRequired * 60) {
          await session.abortTransaction()
          return next(new AppError(`You need to spend at least ${lesson.quizSettings.minimumTimeRequired} minutes on this lesson before taking the quiz`, 403))
        }
      }
    }

    // Get all attempts including inProgress ones
    const allAttempts = await QuizAttempt.find({
      quiz: quiz._id,
      user: userId,
    })
      .sort('-createdAt')
      .session(session)

    // Split attempts by status
    const inProgressAttempts = allAttempts.filter((attempt) => attempt.status === 'inProgress')
    const completedAttempts = allAttempts.filter((attempt) => attempt.status !== 'inProgress')

    // Check if max attempts reached - skip for admin users
    if (!isAdmin && completedAttempts.length >= quiz.maxAttempts) {
      await session.abortTransaction()
      return next(new AppError(`Maximum attempts (${quiz.maxAttempts}) reached`, 400))
    }

    // Step 1: Process expired attempts - mark them as submitted with zero score
    for (const attempt of inProgressAttempts) {
      const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
      const timeSinceStart = new Date() - attempt.startTime

      if (timeSinceStart > timeLimit) {
        // This attempt has expired, mark it as submitted with zero score
        attempt.status = 'submitted'
        attempt.submitTime = new Date(attempt.startTime.getTime() + timeLimit)
        attempt.score = 0
        attempt.percentage = 0
        attempt.passed = false
        await attempt.save({ session })
      } else {
        // Still valid attempt within time window
        await session.abortTransaction()
        return next(new AppError('You have an ongoing quiz attempt', 400))
      }
    }

    // Step 2: At this point all in-progress attempts are either expired (and marked as submitted)
    // or we've returned an error for valid in-progress attempts

    // Step 3: Find highest attempt number across all attempts (both completed and previously in-progress)
    // Re-query to get the updated status of attempts after marking expired ones
    const updatedAttempts = await QuizAttempt.find({
      quiz: quiz._id,
      user: userId,
    }).session(session)

    // Find the highest attempt number
    let highestAttemptNumber = 0
    if (updatedAttempts.length > 0) {
      highestAttemptNumber = Math.max(...updatedAttempts.map((a) => a.attempt))
    }

    // Use next available attempt number
    const nextAttemptNumber = highestAttemptNumber + 1

    // Determine question set based on questionPoolSize
    let questionSet = [...quiz.questions]
    let selectedQuestionIds = []

    // If questionPoolSize is set and less than total questions, select random subset
    if (quiz.questionPoolSize > 0 && quiz.questionPoolSize < quiz.questions.length) {
      // Shuffle questions array
      questionSet = quiz.questions
        .map((q) => ({ q, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ q }) => q)
        .slice(0, quiz.questionPoolSize)
    }

    // Extract just the question IDs for storing in the attempt
    selectedQuestionIds = questionSet.map((q) => q._id)

    // Create new attempt with the selected question set
    const attempt = await QuizAttempt.create(
      [
        {
          quiz: quiz._id,
          user: userId,
          attempt: nextAttemptNumber,
          startTime: new Date(),
          questionSet: selectedQuestionIds,
        },
      ],
      { session }
    )

    // Prepare questions (remove correct answers for MCQs)
    const questions = questionSet.map((q) => ({
      _id: q._id,
      question: q.question,
      type: q.type,
      marks: q.marks,
      options:
        q.type === 'mcq'
          ? q.options.map((opt) => ({
              _id: opt._id,
              option: opt.option,
            }))
          : undefined,
    }))

    await session.commitTransaction()

    // Calculate total marks for the selected questions
    const attemptTotalMarks = questionSet.reduce((sum, q) => sum + q.marks, 0)

    res.status(200).json({
      status: 'success',
      data: {
        attemptId: attempt[0]._id,
        questions,
        questionCount: questions.length,
        totalMarks: attemptTotalMarks,
        quizTime: quiz.quizTime,
        startTime: attempt[0].startTime,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Submit quiz attempt
// exports.submitQuiz = async (req, res, next) => {
//   const session = await mongoose.startSession()
//   session.startTransaction()

//   try {
//     const { courseId, moduleId, lessonId, attemptId } = req.params
//     const { answers } = req.body
//     const userId = req.user._id

//     // Get attempt and quiz
//     const attempt = await QuizAttempt.findOne({
//       _id: attemptId,
//       user: userId,
//       status: 'inProgress',
//     }).session(session)

//     if (!attempt) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz attempt not found or already submitted', 404))
//     }

//     const lesson = await Lesson.findOne({
//       _id: lessonId,
//       module: moduleId,
//       isDeleted: false,
//     })
//       .populate({
//         path: 'quiz',
//         match: { isDeleted: false },
//       })
//       .session(session)

//     if (!lesson || !lesson.quiz) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz not found', 404))
//     }

//     const quiz = lesson.quiz

//     // Check time limit
//     const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
//     const timeTaken = new Date() - attempt.startTime

//     if (timeTaken > timeLimit) {
//       await session.abortTransaction()
//       return next(new AppError('Quiz time limit exceeded', 400))
//     }

//     // Process answers and calculate score
//     let totalScore = 0
//     const processedAnswers = []
//     let needsManualGrading = false

//     for (const answer of answers) {
//       const question = quiz.questions.id(answer.questionId)
//       if (!question) continue

//       const processedAnswer = {
//         questionId: answer.questionId,
//         marks: 0,
//       }

//       if (question.type === 'mcq') {
//         // Handle MCQ
//         const correctOption = question.options.find((opt) => opt.isCorrect)
//         processedAnswer.selectedOption = answer.selectedOption
//         processedAnswer.isCorrect = correctOption && correctOption.option === answer.selectedOption
//         processedAnswer.marks = processedAnswer.isCorrect ? question.marks : 0
//         totalScore += processedAnswer.marks
//       } else {
//         // Handle text answer
//         processedAnswer.textAnswer = answer.textAnswer
//         needsManualGrading = true
//       }

//       processedAnswers.push(processedAnswer)
//     }

//     // Update attempt
//     attempt.answers = processedAnswers
//     attempt.submitTime = new Date()
//     attempt.status = needsManualGrading ? 'submitted' : 'graded'

//     if (!needsManualGrading) {
//       attempt.score = totalScore
//       attempt.percentage = (totalScore / quiz.totalMarks) * 100
//       attempt.passed = attempt.percentage >= quiz.passingScore
//     }

//     await attempt.save({ session })

//     // If all MCQ and passed, update progress
//     if (!needsManualGrading && attempt.percentage >= quiz.passingScore) {
//       let progress = await Progress.findOne({
//         user: userId,
//         course: courseId,
//         module: moduleId,
//       }).session(session)

//       if (!progress) {
//         progress = new Progress({
//           user: userId,
//           course: courseId,
//           module: moduleId,
//           completedLessons: [],
//           completedQuizzes: [],
//           progress: 0,
//           lastAccessed: new Date(),
//         })
//       }

//       if (!progress.completedQuizzes.includes(quiz._id)) {
//         progress.completedQuizzes.push(quiz._id)
//         await progress.save({ session })
//       }
//     }

//     await session.commitTransaction()

//     res.status(200).json({
//       status: 'success',
//       data: {
//         score: attempt.score,
//         percentage: attempt.percentage,
//         passed: attempt.passed,
//         needsManualGrading,
//         answers: processedAnswers,
//       },
//     })
//   } catch (error) {
//     await session.abortTransaction()
//     next(error)
//   } finally {
//     session.endSession()
//   }
// }

exports.submitQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId, attemptId } = req.params
    const { answers } = req.body
    const userId = req.user._id

    // Get attempt and quiz
    const attempt = await QuizAttempt.findOne({
      _id: attemptId,
      user: userId,
      status: 'inProgress',
    }).session(session)

    if (!attempt) {
      await session.abortTransaction()
      return next(new AppError('Quiz attempt not found or already submitted', 404))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate({
        path: 'quiz',
        match: { isDeleted: false },
      })
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Check time limit
    const timeLimit = quiz.quizTime * 60 * 1000 // Convert to milliseconds
    const timeTaken = new Date() - attempt.startTime

    if (timeTaken > timeLimit) {
      await session.abortTransaction()
      return next(new AppError('Quiz time limit exceeded', 400))
    }

    // Process answers and calculate score, only for questions in this attempt's questionSet
    let totalScore = 0
    let totalPossibleMarks = 0
    const processedAnswers = []
    let needsManualGrading = false

    // Get the set of questions for this attempt
    const questionSet = attempt.questionSet || []
    const questionsMap = {}

    // Create a map of question ID to question for quick lookup
    quiz.questions.forEach((q) => {
      questionsMap[q._id.toString()] = q
    })

    for (const answer of answers) {
      // Skip answers for questions not in this attempt's question set
      if (!questionSet.includes(answer.questionId) && !questionSet.some((qId) => qId.toString() === answer.questionId.toString())) {
        continue
      }

      const question = questionsMap[answer.questionId.toString()]
      if (!question) continue

      totalPossibleMarks += question.marks

      const processedAnswer = {
        questionId: answer.questionId,
        marks: 0,
      }

      if (question.type === 'mcq') {
        // Handle MCQ
        const correctOption = question.options.find((opt) => opt.isCorrect)
        processedAnswer.selectedOption = answer.selectedOption
        processedAnswer.isCorrect = correctOption && correctOption.option === answer.selectedOption
        processedAnswer.marks = processedAnswer.isCorrect ? question.marks : 0
        totalScore += processedAnswer.marks
      } else {
        // Handle text answer
        processedAnswer.textAnswer = answer.textAnswer
        needsManualGrading = true
      }

      processedAnswers.push(processedAnswer)
    }

    // Update attempt
    attempt.answers = processedAnswers
    attempt.submitTime = new Date()
    attempt.status = needsManualGrading ? 'submitted' : 'graded'

    if (!needsManualGrading) {
      attempt.score = totalScore
      attempt.percentage = totalPossibleMarks > 0 ? (totalScore / totalPossibleMarks) * 100 : 0
      attempt.passed = attempt.percentage >= quiz.passingScore
    }

    await attempt.save({ session })

    // If all MCQ and passed, update progress
    if (!needsManualGrading && attempt.percentage >= quiz.passingScore) {
      let progress = await Progress.findOne({
        user: userId,
        course: courseId,
        module: moduleId,
      }).session(session)

      if (!progress) {
        progress = new Progress({
          user: userId,
          course: courseId,
          module: moduleId,
          completedLessons: [],
          completedQuizzes: [],
          progress: 0,
          lastAccessed: new Date(),
        })
      }

      if (!progress.completedQuizzes.includes(quiz._id)) {
        progress.completedQuizzes.push(quiz._id)
        await progress.save({ session })
      }
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        score: attempt.score,
        percentage: attempt.percentage,
        passed: attempt.passed,
        needsManualGrading,
        answers: processedAnswers,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Grade text answers (admin/moderator only)
exports.gradeQuiz = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId, attemptId } = req.params
    const { grades } = req.body

    const attempt = await QuizAttempt.findOne({
      _id: attemptId,
      status: 'submitted',
    }).session(session)

    if (!attempt) {
      await session.abortTransaction()
      return next(new AppError('Quiz attempt not found or already graded', 404))
    }

    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate({
        path: 'quiz',
        match: { isDeleted: false },
      })
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Process grades
    let totalScore = 0

    for (const answer of attempt.answers) {
      const grade = grades.find((g) => g.questionId.toString() === answer.questionId.toString())
      const question = quiz.questions.id(answer.questionId)

      if (grade && question) {
        answer.marks = Math.min(grade.marks, question.marks)
        answer.feedback = grade.feedback
        totalScore += answer.marks
      } else if (answer.isCorrect) {
        // Keep the score for autocorrected MCQ answers
        totalScore += answer.marks
      }
    }

    // Update attempt
    attempt.score = totalScore
    attempt.percentage = (totalScore / quiz.totalMarks) * 100
    attempt.passed = attempt.percentage >= quiz.passingScore
    attempt.status = 'graded'
    attempt.gradedBy = req.user._id

    await attempt.save({ session })

    // Update progress if passed
    if (attempt.percentage >= quiz.passingScore) {
      let progress = await Progress.findOne({
        user: attempt.user,
        course: courseId,
        module: moduleId,
      }).session(session)

      if (!progress) {
        progress = new Progress({
          user: attempt.user,
          course: courseId,
          module: moduleId,
          completedLessons: [],
          completedQuizzes: [],
          progress: 0,
          lastAccessed: new Date(),
        })
      }

      if (!progress.completedQuizzes.includes(quiz._id)) {
        progress.completedQuizzes.push(quiz._id)
        await progress.save({ session })
      }
    }

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      data: {
        score: attempt.score,
        percentage: attempt.percentage,
        passed: attempt.passed,
        answers: attempt.answers,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

// Get quiz results
exports.getQuizResults = async (req, res, next) => {
  try {
    const { courseId, moduleId, lessonId, attemptId } = req.params
    const userId = req.user._id

    // Check user has access to this module/course - simplified check
    const user = await User.findById(userId).select('+role +enrolledCourses').lean()

    if (!user) {
      return next(new AppError('User not found', 404))
    }

    const isAdmin = ['admin', 'subAdmin', 'moderator'].includes(user.role)
    let hasAccess = isAdmin

    if (!isAdmin) {
      const enrolledCourse = user.enrolledCourses?.find((ec) => ec.course.toString() === courseId)
      hasAccess = enrolledCourse && (enrolledCourse.enrollmentType === 'full' || enrolledCourse.enrolledModules.some((em) => em.module.toString() === moduleId))
    }

    if (!hasAccess) {
      return next(new AppError('You do not have access to this module', 403))
    }

    const attempt = await QuizAttempt.findOne({
      _id: attemptId,
      user: userId,
    }).populate('quiz')

    if (!attempt) {
      return next(new AppError('Quiz attempt not found', 404))
    }

    const lesson = await Lesson.findById(lessonId).select('quizSettings')

    // Check if review is allowed
    if (!lesson.quizSettings.allowReview) {
      return next(new AppError('Quiz review is not allowed', 403))
    }

    // Prepare results with correct answers
    const results = {
      score: attempt.score,
      percentage: attempt.percentage,
      passed: attempt.passed,
      status: attempt.status,
      startTime: attempt.startTime,
      submitTime: attempt.submitTime,
      answers: attempt.answers.map((answer) => {
        const question = attempt.quiz.questions.id(answer.questionId)
        return {
          question: question.question,
          type: question.type,
          marks: answer.marks,
          maxMarks: question.marks,
          selectedOption: answer.selectedOption,
          textAnswer: answer.textAnswer,
          feedback: answer.feedback,
          correctOption: question.type === 'mcq' && lesson.quizSettings.allowReview ? question.options.find((opt) => opt.isCorrect)?.option : undefined,
        }
      }),
    }

    res.status(200).json({
      status: 'success',
      data: results,
    })
  } catch (error) {
    next(error)
  }
}

exports.resetUserAttempts = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId, lessonId } = req.params
    const { userId } = req.body

    if (!userId) {
      await session.abortTransaction()
      return next(new AppError('User ID is required', 400))
    }

    // Validate lesson exists and has a quiz
    const lesson = await Lesson.findOne({
      _id: lessonId,
      module: moduleId,
      isDeleted: false,
    })
      .populate('quiz')
      .session(session)

    if (!lesson || !lesson.quiz) {
      await session.abortTransaction()
      return next(new AppError('Quiz not found', 404))
    }

    const quiz = lesson.quiz

    // Check if user exists
    const user = await User.findById(userId).session(session)
    if (!user) {
      await session.abortTransaction()
      return next(new AppError('User not found', 404))
    }

    // Get attempt count before deletion
    const attemptCount = await QuizAttempt.countDocuments({
      quiz: quiz._id,
      user: userId,
    }).session(session)

    if (attemptCount === 0) {
      await session.abortTransaction()
      return next(new AppError('No attempts found for this user', 404))
    }

    // Delete all attempts for this user and quiz
    await QuizAttempt.deleteMany({
      quiz: quiz._id,
      user: userId,
    }).session(session)

    // Remove this quiz from user's completed quizzes
    await Progress.updateOne({ user: userId, course: courseId, module: moduleId }, { $pull: { completedQuizzes: quiz._id } }).session(session)

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: `Successfully reset ${attemptCount} attempts for user`,
      data: {
        userId,
        quizId: quiz._id,
        attemptsReset: attemptCount,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}
