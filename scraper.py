import requests
import pandas as pd
import logging
from datetime import datetime
from typing import List, Dict, Optional
from config import get_config
from models import Job, ScrapingLog, get_session

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('scraper.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

config = get_config()


class LegalJobsScraper:
    """Main scraper for legal job positions"""
    
    def __init__(self):
        self.api_key = config.SERPAPI_KEY
        self.search_keywords = config.SEARCH_KEYWORDS
        self.search_location = config.SEARCH_LOCATION
        self.search_language = config.SEARCH_LANGUAGE
        self.base_url = "https://serpapi.com/search"
        self.session = get_session() if config.ENABLE_DATABASE else None
        
    def build_query(self) -> str:
        """Build search query from keywords"""
        keywords = " OR ".join([f'"{kw}"' for kw in self.search_keywords])
        return f"({keywords}) {self.search_location}"
    
    def fetch_jobs(self) -> Optional[List[Dict]]:
        """Fetch jobs from SerpAPI"""
        try:
            params = {
                "engine": "google_jobs",
                "q": self.build_query(),
                "location": self.search_location,
                "hl": self.search_language,
                "api_key": self.api_key
            }
            
            logger.info(f"Fetching jobs with query: {params['q']}")
            response = requests.get(self.base_url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            jobs = data.get("jobs_results", [])
            logger.info(f"Found {len(jobs)} jobs from API")
            return jobs
            
        except requests.exceptions.RequestException as e:
            logger.error(f"API request failed: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error during fetch: {e}")
            return None
    
    def process_jobs(self, jobs: List[Dict]) -> tuple[List[Dict], int, int]:
        """Process and save jobs to database"""
        if not jobs:
            logger.warning("No jobs to process")
            return [], 0, 0
        
        new_jobs = []
        duplicates = 0
        
        for job in jobs:
            try:
                link = job.get("share_link") or job.get("link")
                if not link:
                    logger.warning(f"Job missing link: {job.get('title')}")
                    continue
                
                # Check for duplicates in database
                if config.ENABLE_DATABASE:
                    existing_job = self.session.query(Job).filter_by(job_link=link).first()
                    if existing_job:
                        duplicates += 1
                        logger.debug(f"Duplicate found: {link}")
                        continue
                
                # Create new job record
                job_record = {
                    "title": job.get("title", "N/A"),
                    "company_name": job.get("company_name", "N/A"),
                    "location": job.get("location", "N/A"),
                    "source": job.get("via", "N/A"),
                    "job_link": link,
                    "description": job.get("description", ""),
                    "posted_date": job.get("detected_extensions", {}).get("posted_at"),
                }
                
                new_jobs.append(job_record)
                
            except Exception as e:
                logger.error(f"Error processing job: {e}")
                continue
        
        logger.info(f"Processed: {len(new_jobs)} new jobs, {duplicates} duplicates")
        return new_jobs, len(new_jobs), duplicates
    
    def save_to_database(self, jobs: List[Dict]) -> bool:
        """Save jobs to PostgreSQL/SQLite database"""
        if not config.ENABLE_DATABASE or not self.session or not jobs:
            return False
        
        try:
            for job_data in jobs:
                job = Job(**job_data)
                self.session.add(job)
            
            self.session.commit()
            logger.info(f"Successfully saved {len(jobs)} jobs to database")
            return True
            
        except Exception as e:
            self.session.rollback()
            logger.error(f"Database save error: {e}")
            return False
    
    def save_to_csv(self, jobs: List[Dict], filename: str = "gunluk_hukuk_ilanlari.csv") -> bool:
        """Save jobs to CSV file"""
        try:
            if not jobs:
                logger.warning("No jobs to save to CSV")
                return False
            
            df = pd.DataFrame(jobs)
            df["collected_date"] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            
            file_exists = pd.io.common.file_exists(filename) if hasattr(pd.io, 'common') else False
            try:
                file_exists = pd.read_csv(filename, nrows=0) is not None
            except:
                file_exists = False
            
            df.to_csv(filename, mode='a', index=False, header=not file_exists)
            logger.info(f"Saved {len(jobs)} jobs to CSV: {filename}")
            return True
            
        except Exception as e:
            logger.error(f"CSV save error: {e}")
            return False
    
    def log_scraping_operation(self, jobs_found: int, jobs_added: int, 
                              duplicates: int, errors: str = None, 
                              status: str = "success"):
        """Log scraping operation to database"""
        if not config.ENABLE_DATABASE or not self.session:
            return
        
        try:
            log = ScrapingLog(
                jobs_found=jobs_found,
                jobs_added=jobs_added,
                duplicates_skipped=duplicates,
                errors=errors,
                status=status
            )
            self.session.add(log)
            self.session.commit()
            logger.info(f"Scraping operation logged: {status}")
        except Exception as e:
            logger.error(f"Error logging operation: {e}")
    
    def run(self) -> Dict:
        """Execute full scraping workflow"""
        logger.info("=" * 50)
        logger.info("Starting job scraping process...")
        logger.info("=" * 50)
        
        result = {
            "timestamp": datetime.now().isoformat(),
            "success": False,
            "jobs_found": 0,
            "jobs_added": 0,
            "duplicates_skipped": 0,
            "error": None
        }
        
        try:
            # Fetch jobs from API
            jobs = self.fetch_jobs()
            if jobs is None:
                result["error"] = "Failed to fetch jobs from API"
                self.log_scraping_operation(0, 0, 0, result["error"], "failed")
                return result
            
            result["jobs_found"] = len(jobs)
            
            # Process jobs
            processed_jobs, new_count, dup_count = self.process_jobs(jobs)
            result["jobs_added"] = new_count
            result["duplicates_skipped"] = dup_count
            
            if not processed_jobs:
                logger.info("No new jobs found")
                self.log_scraping_operation(result["jobs_found"], 0, dup_count, None, "success")
                result["success"] = True
                return result
            
            # Save to both database and CSV
            db_saved = self.save_to_database(processed_jobs) if config.ENABLE_DATABASE else True
            csv_saved = self.save_to_csv(processed_jobs)
            
            if db_saved or csv_saved:
                result["success"] = True
                self.log_scraping_operation(result["jobs_found"], new_count, dup_count, None, "success")
                logger.info(f"Scraping completed successfully!")
            else:
                result["error"] = "Failed to save jobs"
                self.log_scraping_operation(result["jobs_found"], new_count, dup_count, result["error"], "partial")
            
        except Exception as e:
            result["error"] = str(e)
            logger.error(f"Unexpected error in scraping: {e}")
            self.log_scraping_operation(0, 0, 0, str(e), "failed")
        
        finally:
            if self.session:
                self.session.close()
        
        logger.info("=" * 50)
        logger.info(f"Result: {result}")
        logger.info("=" * 50)
        return result


if __name__ == "__main__":
    scraper = LegalJobsScraper()
    result = scraper.run()
