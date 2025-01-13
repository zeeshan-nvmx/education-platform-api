const mongoose = require('mongoose')
const { Course, User, Module } = require('../models')
const { AppError } = require('../utils/errors')

/**
 * Test enrollment in a full course
 */
exports.enrollInCourse = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId } = req.params

    // Get user and course sequentially with session
    const user = await User.findById(req.user._id).session(session)
    const course = await Course.findOne({
      _id: courseId,
      isDeleted: false,
    }).session(session)

    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    // Check if already enrolled
    const existingEnrollment = user.enrolledCourses.find((ec) => ec.course.toString() === courseId)

    if (existingEnrollment) {
      await session.abortTransaction()
      return next(new AppError('Already enrolled in this course', 400))
    }

    // Create enrollment with proper structure
    const enrollment = {
      course: courseId,
      enrollmentType: 'full',
      enrolledAt: new Date(),
      enrolledModules: [],
    }

    user.enrolledCourses.push(enrollment)

    // Increment course total students
    course.totalStudents += 1

    // Save both documents
    await Promise.all([user.save({ session }), course.save({ session })])

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Successfully enrolled in course',
      data: enrollment,
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}

/**
 * Test enrollment in a specific module
 */
exports.enrollInModule = async (req, res, next) => {
  const session = await mongoose.startSession()
  session.startTransaction()

  try {
    const { courseId, moduleId } = req.params

    // Get all required documents
    const user = await User.findById(req.user._id).session(session)
    const course = await Course.findOne({
      _id: courseId,
      isDeleted: false,
    }).session(session)
    const module = await Module.findOne({
      _id: moduleId,
      course: courseId,
      isDeleted: false,
    }).session(session)

    // Validate course and module
    if (!course) {
      await session.abortTransaction()
      return next(new AppError('Course not found', 404))
    }

    if (!module) {
      await session.abortTransaction()
      return next(new AppError('Module not found in this course', 404))
    }

    // Find or prepare course enrollment
    let courseEnrollment = user.enrolledCourses.find((ec) => ec.course.toString() === courseId)

    if (courseEnrollment) {
      // Check enrollment type
      if (courseEnrollment.enrollmentType === 'full') {
        await session.abortTransaction()
        return next(new AppError('Already have full access to this course', 400))
      }

      // Check if module is already enrolled
      if (courseEnrollment.enrolledModules.some((em) => em.module.toString() === moduleId)) {
        await session.abortTransaction()
        return next(new AppError('Already enrolled in this module', 400))
      }
    } else {
      // Create new course enrollment for module
      courseEnrollment = {
        course: courseId,
        enrollmentType: 'module',
        enrolledAt: new Date(),
        enrolledModules: [],
      }
      user.enrolledCourses.push(courseEnrollment)
    }

    // Add new module enrollment with full structure
    const moduleEnrollment = {
      module: moduleId,
      enrolledAt: new Date(),
      completedLessons: [],
      completedQuizzes: [],
      lastAccessed: new Date(),
    }

    courseEnrollment.enrolledModules.push(moduleEnrollment)

    // Increment course total students if this is their first module
    if (courseEnrollment.enrolledModules.length === 1) {
      course.totalStudents += 1
      await course.save({ session })
    }

    await user.save({ session })

    await session.commitTransaction()

    res.status(200).json({
      status: 'success',
      message: 'Successfully enrolled in module',
      data: {
        courseId,
        moduleId,
        enrollment: courseEnrollment,
      },
    })
  } catch (error) {
    await session.abortTransaction()
    next(error)
  } finally {
    session.endSession()
  }
}
