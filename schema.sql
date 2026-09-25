-- ══════════════════════════════════════════════════════════════════
-- Ajanta Appliances Task Manager — MySQL schema
-- Mirrors the table/column layout in sheets-db.js's SCHEMA constant,
-- so server.js's existing SQL (written for a real MySQL pool) runs
-- unchanged against this.
-- ══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  notification_email VARCHAR(255),
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50),
  phone VARCHAR(50),
  profile_image MEDIUMTEXT,
  department VARCHAR(100),
  week_off VARCHAR(50),
  extra_off VARCHAR(50),
  is_active TINYINT DEFAULT 1,
  page_access TEXT DEFAULT NULL,
  force_logout_at DATETIME DEFAULT NULL,
  track_km TINYINT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS delegation_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(500),
  description TEXT,
  assigned_to INT,
  assigned_by INT,
  due_date DATE,
  start_date DATE,
  status VARCHAR(50),
  priority VARCHAR(50),
  approval VARCHAR(50),
  waiting_approval INT DEFAULT 0,
  remarks TEXT,
  link VARCHAR(1000),
  revision_status VARCHAR(50),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_reminder_date DATE,
  completed_at DATETIME,
  INDEX idx_assigned_to (assigned_to),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS checklist_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(500),
  description TEXT,
  assigned_to INT,
  assigned_by INT,
  due_date DATE,
  start_date DATE,
  status VARCHAR(50),
  priority VARCHAR(50),
  remarks TEXT,
  frequency VARCHAR(50),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  INDEX idx_assigned_to (assigned_to),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT,
  task_type VARCHAR(50),
  requested_by INT,
  requested_to INT,
  action_type VARCHAR(50),
  status VARCHAR(50),
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task (task_id, task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT,
  task_type VARCHAR(50),
  from_user INT,
  to_user INT,
  requested_by INT,
  status VARCHAR(50),
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task (task_id, task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT,
  task_type VARCHAR(50),
  user_id INT,
  comment TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task (task_id, task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS week_plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT,
  hod_id INT,
  start_date DATE,
  target_count INT,
  improvement_pct INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_employee_week (employee_id, start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fms_sheets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fms_name VARCHAR(255),
  sheet_name VARCHAR(255),
  sheet_id VARCHAR(500),
  header_row INT,
  total_steps INT,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fms_steps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fms_id INT,
  step_order INT,
  step_name VARCHAR(255),
  plan_col VARCHAR(10),
  actual_col VARCHAR(10),
  extra_input VARCHAR(10),
  extra_col VARCHAR(10),
  show_cols TEXT,
  delay_reason_col VARCHAR(10),
  doer_name_col VARCHAR(10),
  INDEX idx_fms_id (fms_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fms_step_doers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  step_id INT,
  user_id INT,
  INDEX idx_step_id (step_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fms_extra_rows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  step_id INT,
  row_label VARCHAR(255),
  col_letter VARCHAR(10),
  field_type VARCHAR(50),
  dropdown_options TEXT,
  INDEX idx_step_id (step_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS holidays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date DATE,
  name VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS o2d_dealers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  counter_name VARCHAR(255) NOT NULL UNIQUE,
  city VARCHAR(255),
  phone VARCHAR(50),
  credit_limit DECIMAL(12,2),
  location_lat DECIMAL(10,7),
  location_lng DECIMAL(10,7),
  location_address VARCHAR(500),
  kyc_aadhar_url VARCHAR(1000),
  kyc_pan_url VARCHAR(1000),
  kyc_gst_url VARCHAR(1000),
  kyc_shop_url VARCHAR(1000),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS o2d_step_doers (
  step_n INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (step_n, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS purchase_step_doers (
  step_n INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (step_n, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS o2d_dealer_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  counter_name VARCHAR(255) NOT NULL,
  amount DECIMAL(12,2),
  due_date DATE,
  paid_date DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_counter (counter_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- km_start/km_end intentionally absent — KM tracking moved to the `rides`
-- table below (2026-09-25) so a field employee can log several trips a day
-- instead of one KM pair tied to the attendance punch.
CREATE TABLE IF NOT EXISTS attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  date DATE NOT NULL,
  time_in DATETIME,
  time_out DATETIME,
  lat_in DECIMAL(10,7),
  lng_in DECIMAL(10,7),
  address_in VARCHAR(500),
  lat_out DECIMAL(10,7),
  lng_out DECIMAL(10,7),
  address_out VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_date (user_id, date),
  INDEX idx_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leave_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  leave_type VARCHAR(50),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days DECIMAL(4,1),
  reason TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  approved_by INT,
  approved_at DATETIME,
  remarks TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rides (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  start_time DATETIME NOT NULL,
  km_start DECIMAL(10,2),
  lat_start DECIMAL(10,7),
  lng_start DECIMAL(10,7),
  address_start VARCHAR(500),
  end_time DATETIME,
  km_end DECIMAL(10,2),
  lat_end DECIMAL(10,7),
  lng_end DECIMAL(10,7),
  address_end VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_start (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
