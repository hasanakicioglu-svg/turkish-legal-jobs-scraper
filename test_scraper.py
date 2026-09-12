import pytest
import os
from datetime import datetime
from unittest.mock import patch, MagicMock
from config import TestingConfig
from models import Job, ScrapingLog, init_db, get_session
from scraper import LegalJobsScraper
from notifier import EmailNotifier


@pytest.fixture
def config():
    """Provide testing configuration"""
    return TestingConfig()


@pytest.fixture
def scraper():
    """Provide scraper instance for testing"""
    return LegalJobsScraper()


@pytest.fixture
def email_notifier():
    """Provide email notifier instance"""
    return EmailNotifier()


@pytest.fixture
def db_session():
    """Setup and teardown test database"""
    init_db()
    session = get_session()
    yield session
    session.close()


class TestLegalJobsScraper:
    """Test cases for LegalJobsScraper"""
    
    def test_scraper_initialization(self, scraper):
        """Test scraper initializes correctly"""
        assert scraper.api_key is not None
        assert scraper.search_keywords is not None
        assert scraper.search_location == "Turkey"
    
    def test_build_query(self, scraper):
        """Test search query building"""
        query = scraper.build_query()
        assert "Turkey" in query
        assert len(query) > 0
    
    @patch('requests.get')
    def test_fetch_jobs_success(self, mock_get, scraper):
        """Test successful job fetching"""
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "jobs_results": [
                {
                    "title": "Head of Legal",
                    "company_name": "Test Company",
                    "location": "Istanbul",
                    "share_link": "http://example.com/job1",
                    "via": "LinkedIn"
                }
            ]
        }
        mock_get.return_value = mock_response
        
        jobs = scraper.fetch_jobs()
        assert jobs is not None
        assert len(jobs) == 1
        assert jobs[0]["title"] == "Head of Legal"
    
    @patch('requests.get')
    def test_fetch_jobs_failure(self, mock_get, scraper):
        """Test failed job fetching"""
        mock_get.side_effect = Exception("API Error")
        
        jobs = scraper.fetch_jobs()
        assert jobs is None
    
    def test_process_jobs_with_duplicates(self, scraper, db_session):
        """Test duplicate detection"""
        # Add existing job to database
        existing_job = Job(
            title="Head of Legal",
            company_name="Test Company",
            job_link="http://example.com/job1"
        )
        db_session.add(existing_job)
        db_session.commit()
        
        # Try to process same job
        jobs_to_process = [
            {
                "title": "Head of Legal",
                "company_name": "Test Company",
                "location": "Istanbul",
                "share_link": "http://example.com/job1",
                "via": "LinkedIn"
            }
        ]
        
        processed, new_count, dup_count = scraper.process_jobs(jobs_to_process)
        assert new_count == 0
        assert dup_count == 1
    
    def test_process_jobs_new(self, scraper):
        """Test processing new jobs"""
        jobs_to_process = [
            {
                "title": "Head of Legal",
                "company_name": "Test Company",
                "location": "Istanbul",
                "share_link": "http://example.com/job1",
                "via": "LinkedIn"
            },
            {
                "title": "Legal Manager",
                "company_name": "Another Company",
                "location": "Ankara",
                "share_link": "http://example.com/job2",
                "via": "Indeed"
            }
        ]
        
        processed, new_count, dup_count = scraper.process_jobs(jobs_to_process)
        assert len(processed) == 2
        assert new_count == 2
        assert dup_count == 0
    
    def test_save_to_database(self, scraper, db_session):
        """Test saving jobs to database"""
        jobs = [
            {
                "title": "Head of Legal",
                "company_name": "Test Company",
                "location": "Istanbul",
                "source": "LinkedIn",
                "job_link": "http://example.com/job1"
            }
        ]
        
        scraper.session = db_session
        result = scraper.save_to_database(jobs)
        
        assert result is True
        saved_job = db_session.query(Job).filter_by(job_link="http://example.com/job1").first()
        assert saved_job is not None
        assert saved_job.title == "Head of Legal"


class TestEmailNotifier:
    """Test cases for EmailNotifier"""
    
    def test_email_notifier_initialization(self, email_notifier):
        """Test notifier initializes correctly"""
        assert email_notifier.smtp_server is not None
        assert email_notifier.smtp_port is not None
    
    def test_validate_config_incomplete(self, email_notifier):
        """Test config validation with incomplete settings"""
        email_notifier.sender_email = None
        assert email_notifier.validate_config() is False
    
    def test_format_job_html(self, email_notifier):
        """Test HTML job formatting"""
        job = {
            "title": "Head of Legal",
            "company_name": "Test Company",
            "location": "Istanbul",
            "source": "LinkedIn",
            "job_link": "http://example.com/job1"
        }
        
        html = email_notifier.format_job_html(job)
        assert "Head of Legal" in html
        assert "Test Company" in html
        assert "İlanı Görüntüle" in html


class TestModels:
    """Test cases for database models"""
    
    def test_job_model_creation(self, db_session):
        """Test Job model creation"""
        job = Job(
            title="Head of Legal",
            company_name="Test Company",
            location="Istanbul",
            job_link="http://example.com/job1"
        )
        db_session.add(job)
        db_session.commit()
        
        retrieved_job = db_session.query(Job).filter_by(job_link="http://example.com/job1").first()
        assert retrieved_job is not None
        assert retrieved_job.title == "Head of Legal"
    
    def test_job_to_dict(self, db_session):
        """Test Job to_dict method"""
        job = Job(
            title="Head of Legal",
            company_name="Test Company",
            location="Istanbul",
            job_link="http://example.com/job1"
        )
        db_session.add(job)
        db_session.commit()
        
        job_dict = job.to_dict()
        assert job_dict["title"] == "Head of Legal"
        assert job_dict["company_name"] == "Test Company"
        assert "collected_date" in job_dict
    
    def test_scraping_log_creation(self, db_session):
        """Test ScrapingLog model creation"""
        log = ScrapingLog(
            jobs_found=10,
            jobs_added=8,
            duplicates_skipped=2,
            status="success"
        )
        db_session.add(log)
        db_session.commit()
        
        retrieved_log = db_session.query(ScrapingLog).first()
        assert retrieved_log is not None
        assert retrieved_log.jobs_found == 10
        assert retrieved_log.status == "success"


class TestIntegration:
    """Integration tests"""
    
    @patch('requests.get')
    def test_full_scraping_workflow(self, mock_get, scraper, db_session):
        """Test complete scraping workflow"""
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "jobs_results": [
                {
                    "title": "Head of Legal",
                    "company_name": "Test Company",
                    "location": "Istanbul",
                    "share_link": "http://example.com/job1",
                    "via": "LinkedIn"
                }
            ]
        }
        mock_get.return_value = mock_response
        
        scraper.session = db_session
        result = scraper.run()
        
        assert result["success"] is True
        assert result["jobs_found"] >= 1
        assert result["jobs_added"] >= 1
    
    def test_api_health_endpoint(self):
        """Test API health endpoint"""
        from app import app
        
        with app.test_client() as client:
            response = client.get('/api/health')
            assert response.status_code == 200
            data = response.get_json()
            assert data["status"] == "healthy"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--cov=."])
