# config
styles/defaults.json
# query
SELECT
    department_id,
    COUNT(*) AS employee_count,
    AVG(salary) AS avg_salary
FROM
    employees
WHERE
    status = 1
GROUP BY
    department_id
HAVING
    COUNT(*) > 5
ORDER BY
    avg_salary DESC