const { User } = require('../models')

exports.checkCourseEnrollment = async (req, res, next) => {
  const courseId = req.params.courseId
  const enrollment = req.user.enrolledCourses.find((ec) => ec.course.toString() === courseId)

  if (!enrollment) {
    return next(new AppError('You are not enrolled in this course', 403))
  }

  req.enrollment = enrollment
  next()
}

exports.checkModuleAccess = async (req, res, next) => {
  const moduleId = req.params.moduleId
  const enrollment = req.user.enrolledCourses.find((ec) => ec.completedModules.includes(moduleId))

  if (!enrollment) {
    return next(new AppError('You do not have access to this module', 403))
  }

  next()
}
